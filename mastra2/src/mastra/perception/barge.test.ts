import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { PerceptionSession } from "./session.ts";
import { ttsChunkDurationMs } from "./tts.ts";
import { SustainedSpeechGate } from "./vad.ts";
import { AdaptiveSilenceTurnDetector } from "./turn.ts";
import { CascadeTurnYield, EffortWindow } from "./turn-yield.ts";

/** Simulate 20 ms VAD frames. */
function feedFrames(
  gate: SustainedSpeechGate,
  isSpeech: boolean,
  count: number,
): boolean {
  let met = false;
  for (let i = 0; i < count; i++) {
    if (gate.feed(isSpeech)) met = true;
  }
  return met;
}

describe("SustainedSpeechGate (listen open)", () => {
  it("ignores short bursts shorter than sustain (backchannel-like)", () => {
    const gate = new SustainedSpeechGate(180); // 9 frames @ 20ms
    assert.equal(feedFrames(gate, true, 4), false);
    assert.equal(gate.feed(false), false);
    assert.equal(feedFrames(gate, true, 4), false);
  });

  it("fires after continuous speech ≥ sustainMs", () => {
    const gate = new SustainedSpeechGate(180);
    assert.equal(feedFrames(gate, true, 8), false);
    assert.equal(gate.feed(true), true);
  });

  it("resets run on silence so noise + speech does not accumulate", () => {
    const gate = new SustainedSpeechGate(180);
    feedFrames(gate, true, 6);
    gate.feed(false);
    assert.equal(feedFrames(gate, true, 6), false);
    assert.equal(feedFrames(gate, true, 3), true);
  });
});

describe("AdaptiveSilenceTurnDetector (adaptive EOU)", () => {
  it("requires longer silence after a short/noisy burst", () => {
    const turn = new AdaptiveSilenceTurnDetector();
    const t0 = 1000;
    for (let t = t0; t < t0 + 300; t += 20) {
      assert.equal(turn.onVad({ isSpeech: true, energy: 0.1 }, t), false);
    }
    assert.equal(
      turn.onVad({ isSpeech: false, energy: 0 }, t0 + 300 + 500),
      false,
    );
    assert.equal(
      turn.onVad({ isSpeech: false, energy: 0 }, t0 + 300 + 1100),
      true,
    );
  });

  it("commits faster after sustained speech (mid-sentence pause tolerance)", () => {
    const turn = new AdaptiveSilenceTurnDetector();
    const t0 = 0;
    for (let t = t0; t < 2200; t += 20) {
      turn.onVad({ isSpeech: true, energy: 0.2 }, t);
    }
    assert.equal(turn.onVad({ isSpeech: false, energy: 0 }, 2200 + 350), false);
    assert.equal(turn.onVad({ isSpeech: false, energy: 0 }, 2200 + 400), true);
  });

  it("silenceNeededMs increases for short utterances", () => {
    const turn = new AdaptiveSilenceTurnDetector();
    assert.ok(turn.silenceNeededMs(260) > turn.silenceNeededMs(2500));
  });
});

describe("EffortWindow", () => {
  it("requires a full ~300ms window before met()", () => {
    const w = new EffortWindow(300); // 15 frames
    for (let i = 0; i < 14; i++) {
      w.push(0.9);
      assert.equal(w.met(0.35), false);
    }
    w.push(0.9);
    assert.equal(w.met(0.35), true);
  });

  it("resets so a cough burst does not carry over", () => {
    const w = new EffortWindow(300);
    for (let i = 0; i < 10; i++) w.push(0.9);
    w.reset();
    assert.equal(w.met(0.35), false);
    w.push(0.9);
    assert.equal(w.met(0.35), false);
  });
});

describe("CascadeTurnYield (turn-yield ≠ VAD)", () => {
  const speaking = {
    ttsActive: true,
    echoUntil_ms: 0,
    agentState: "speaking" as const,
  };

  it("soft-pauses on first voiced frame, hard-yields after sustain+effort", () => {
    const y = new CascadeTurnYield({
      sustainMs: 180,
      effortMs: 300,
      effortThreshold: 0.35,
    });
    let softAt: number | null = null;
    let hardAt: number | null = null;

    for (let t = 0; t <= 400; t += 20) {
      const action = y.feed({
        t_ms: t,
        vad: { isSpeech: true, energy: 0.7 },
        ...speaking,
      });
      if (action === "soft_candidate" && softAt == null) softAt = t;
      if (action === "hard_yield") {
        hardAt = t;
        break;
      }
    }

    assert.equal(softAt, 0);
    assert.ok(hardAt != null, "expected hard_yield");
    // Effort window is 300ms (stricter than 180ms sustain)
    assert.ok(hardAt! >= 280, `hard_yield at ${hardAt} too early`);
    assert.ok(
      hardAt! - softAt! <= 320,
      `soft→hard ${hardAt! - softAt!}ms exceeds effort window`,
    );
  });

  it("cough / short burst: soft then clear, never hard_yield", () => {
    const y = new CascadeTurnYield({
      sustainMs: 180,
      effortMs: 300,
      effortThreshold: 0.35,
    });
    // ~100ms voiced
    assert.equal(
      y.feed({
        t_ms: 0,
        vad: { isSpeech: true, energy: 0.9 },
        ...speaking,
      }),
      "soft_candidate",
    );
    for (let t = 20; t < 100; t += 20) {
      assert.equal(
        y.feed({
          t_ms: t,
          vad: { isSpeech: true, energy: 0.9 },
          ...speaking,
        }),
        "none",
      );
    }
    assert.equal(
      y.feed({
        t_ms: 100,
        vad: { isSpeech: false, energy: 0 },
        ...speaking,
      }),
      "clear",
    );
    // More silence — still no hard yield
    assert.equal(
      y.feed({
        t_ms: 200,
        vad: { isSpeech: false, energy: 0 },
        ...speaking,
      }),
      "none",
    );
  });

  it("echo floor clears soft candidate and blocks yield", () => {
    const y = new CascadeTurnYield({
      sustainMs: 180,
      effortMs: 300,
      effortThreshold: 0.35,
    });
    assert.equal(
      y.feed({
        t_ms: 50,
        vad: { isSpeech: true, energy: 0.9 },
        ttsActive: true,
        echoUntil_ms: 350,
        agentState: "speaking",
      }),
      "none",
    );
  });
});

/** A `chunkMs`-ms int16 mono PCM chunk at 16 kHz (32 bytes per ms). */
function pcmChunk(chunkMs: number): { audio: Buffer; mime: string } {
  return {
    audio: Buffer.alloc(chunkMs * 32),
    mime: "audio/L16;rate=16000;channels=1",
  };
}

function makeEchoSession(opts: {
  chunks: number;
  chunkMs: number;
  pcm: boolean;
  listenArmMs: number;
  echoMarginMs: number;
}): PerceptionSession {
  const sentence =
    "The quick brown fox keeps talking for a long synthetic tail.";
  return new PerceptionSession({
    agent: {
      stream: async () => ({
        fullStream: (async function* () {
          yield { type: "text-delta", payload: { text: sentence } };
        })(),
      }),
    } as unknown as Agent,
    memory: {} as Memory,
    vad: { process: () => ({ isSpeech: false, energy: 0 }), reset: () => {} },
    turn: { onVad: () => false, reset: () => {} },
    asr: { finalize: async () => "", reset: () => {} },
    tts: {
      synthesize: async function* () {
        for (let i = 0; i < opts.chunks; i++) {
          yield opts.pcm
            ? pcmChunk(opts.chunkMs)
            : { text: "chunk", mime: "text/plain" };
        }
      },
      stop: () => {},
    },
    vision: {
      getScene: () => ({
        at: 0,
        people: "",
        objects_changed: [],
        readouts: [],
        confidence: 0,
      }),
      onFrame: async () => null,
      reset: () => {},
    },
    clientOwnsAsr: true,
    listenArmMs: opts.listenArmMs,
    echoMarginMs: opts.echoMarginMs,
    progress: { enabled: false },
  });
}

async function speakTurn(session: PerceptionSession): Promise<void> {
  const flushed = new Promise<void>((resolve) => {
    const off = session.bus.on("tts_flush", () => {
      off();
      resolve();
    });
  });
  session.onTextUtterance("tell me something long", 1000);
  await flushed;
}

describe("ttsChunkDurationMs (chunk-derived floor)", () => {
  it("derives ms from int16 PCM size and rate", () => {
    assert.equal(
      ttsChunkDurationMs({ audio: Buffer.alloc(6400), mime: "audio/L16;rate=16000;channels=1" }),
      200,
    );
    assert.equal(
      ttsChunkDurationMs({ audio: Buffer.alloc(6400), mime: "audio/pcm" }),
      200,
    );
    assert.equal(ttsChunkDurationMs({ audio: Buffer.alloc(3244), mime: "audio/wav" }), 100);
  });

  it("divides duration by channel count (stereo L16)", () => {
    // 6400 B @ 16 kHz: /2 bytes-per-sample /2 channels /16 samples-per-ms
    // = 100 ms per channel. Ignoring channels would double it to 200.
    assert.equal(
      ttsChunkDurationMs({ audio: Buffer.alloc(6400), mime: "audio/L16;rate=16000;channels=2" }),
      100,
    );
    assert.equal(
      ttsChunkDurationMs({ audio: Buffer.alloc(6400), mime: "audio/pcm;rate=8000;channels=4" }),
      100,
    );
    assert.equal(
      ttsChunkDurationMs({ audio: Buffer.alloc(6400), mime: "audio/L16;rate=16000;channels=1" }),
      200,
    );
    // Bad channel spec falls back to mono, never divides by zero.
    assert.equal(
      ttsChunkDurationMs({ audio: Buffer.alloc(6400), mime: "audio/L16;rate=16000;channels=0" }),
      200,
    );
  });

  it("returns null when duration cannot be derived", () => {
    assert.equal(ttsChunkDurationMs({ audio: Buffer.alloc(6400), mime: "audio/mpeg" }), null);
    assert.equal(ttsChunkDurationMs({ text: "hi", mime: "text/plain" }), null);
    assert.equal(ttsChunkDurationMs({}), null);
  });
});

describe("session: dynamic echo floor (ADR-006)", () => {
  // Static fallback seed for this harness: 1000 (media clock) + 700 listen-arm.
  const FALLBACK_UNTIL = 1700;

  it("covers the residual tail of issued audio, not a fixed guess", async () => {
    // 10 x 200 ms PCM chunks issued at media t=1000 -> audio ends t=3000.
    const session = makeEchoSession({
      chunks: 10,
      chunkMs: 200,
      pcm: true,
      listenArmMs: 700,
      echoMarginMs: 300,
    });
    try {
      await speakTurn(session);
      // Mid-playback: floor = t + residual + margin (350 ms tail + 300 margin).
      assert.equal(session.echoFloorAt(2650) - 2650, 350 + 300);
      // Before the tail: floor pins at audioIssuedEndAt + margin.
      assert.equal(session.echoFloorAt(1500), 3000 + 300);
      // After the last chunk: window decays to the margin alone.
      assert.equal(session.echoFloorAt(3050) - 3050, 300);
    } finally {
      session.reset();
    }
  });

  it("resets the derived window when playback truly ends", async () => {
    const session = makeEchoSession({
      chunks: 10,
      chunkMs: 200,
      pcm: true,
      listenArmMs: 700,
      echoMarginMs: 300,
    });
    try {
      await speakTurn(session);
      session.onPlaybackDone(3100);
      // Residual gone: back to the static listen-arm seed, not t + margin.
      assert.equal(session.echoFloorAt(3150), FALLBACK_UNTIL);
    } finally {
      session.reset();
    }
  });

  it("falls back to LISTEN_ARM_MS when no chunk durations (mock TTS)", async () => {
    const session = makeEchoSession({
      chunks: 10,
      chunkMs: 200,
      pcm: false,
      listenArmMs: 700,
      echoMarginMs: 300,
    });
    try {
      await speakTurn(session);
      // Text-only chunks carry no duration; the fixed 700 ms seed applies.
      assert.equal(session.echoFloorAt(1200), FALLBACK_UNTIL);
      assert.equal(session.echoFloorAt(2500), FALLBACK_UNTIL);
    } finally {
      session.reset();
    }
  });
});
