/**
 * ADR-006 live-path coverage (review F1): the dynamic echo floor must apply
 * while audio is still scheduled client-side even after playbackOpen was
 * released by the playback_done watchdog. The drain-timeout window is the
 * real-world case: 15 PCM chunks finish SYNTHESISING by media t=3000 but the
 * last ~1 s is still PLAYING when the watchdog fires at t=3100.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { PerceptionSession } from "./session.ts";
import type { PcmFrame } from "./types.ts";

const FRAME_MS = 20;
const CHUNK_MS = 200;
const CHUNKS = 15;
const MARGIN_MS = 300;
const LISTEN_ARM_MS = 700;
/** Turn starts at media t=1000; issued audio ends 1000 + 15*200 = 4000. */
const START_MS = 1000;
const END_AT_MS = START_MS + CHUNKS * CHUNK_MS; // 4000
/** Watchdog fires here (REAL ms — media clock values below are fictional):
 * playbackOpen false, audio still out until media t=4000. */
const DRAIN_AT_MS = 3100;
const TIMEOUT_REAL_MS = 30;
const WINDOW_END_MS = END_AT_MS + MARGIN_MS; // 4300

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drains a spoken turn and arms a short playback_done watchdog so the drain
 * timeout can fire in real time shortly after `tts_flush`.
 */
function makeLiveSession(): {
  session: PerceptionSession;
  /** VAD mock: next frames report speech when true. */
  setSpeech: (on: boolean) => void;
} {
  let speech = false;
  const sentence =
    "The quick brown fox keeps talking for a long synthetic tail.";
  const session = new PerceptionSession({
    agent: {
      stream: async () => ({
        fullStream: (async function* () {
          yield { type: "text-delta", payload: { text: sentence } };
        })(),
      }),
    } as unknown as Agent,
    memory: {} as Memory,
    vad: {
      process: () => ({ isSpeech: speech, energy: speech ? 0.85 : 0 }),
      reset: () => {},
    },
    turn: { onVad: () => false, reset: () => {} },
    asr: { finalize: async () => "", reset: () => {} },
    tts: {
      synthesize: async function* () {
        for (let i = 0; i < CHUNKS; i++) {
          yield {
            audio: Buffer.alloc(CHUNK_MS * 32),
            mime: "audio/L16;rate=16000;channels=1",
          };
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
    bargeInEnabled: true,
    listenArmMs: LISTEN_ARM_MS,
    echoMarginMs: MARGIN_MS,
    playbackDoneTimeoutMs: TIMEOUT_REAL_MS,
    progress: { enabled: false },
  });
  return { session, setSpeech: (on) => (speech = on) };
}

function speakTurn(session: PerceptionSession): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = session.bus.on("tts_flush", () => {
      off();
      resolve();
    });
    const offErr = session.bus.on("error", (e: { error?: string }) => {
      off();
      reject(new Error(e?.error ?? "session error"));
    });
    session.onTextUtterance("tell me something long", START_MS);
  });
}

/** Feed voiced 20 ms frames in [fromMs, toMs), awaiting each. */
async function feedVoiced(
  session: PerceptionSession,
  fromMs: number,
  toMs: number,
): Promise<void> {
  for (let t = fromMs; t < toMs; t += FRAME_MS) {
    const frame: PcmFrame = { t_ms: t, samples: new Int16Array(320) };
    await session.onAudio(frame);
  }
}

describe("session: dynamic echo floor survives drain timeout (F1)", () => {
  it("drain timeout: suppresses inside the residual window, hard-yields past the horizon", async () => {
    const { session, setSpeech } = makeLiveSession();
    let barges = 0;
    let softPauses = 0;
    const off1 = session.bus.on("barge_in", () => barges++);
    const off2 = session.bus.on("barge_soft_pause", () => softPauses++);
    try {
      await speakTurn(session);
      // Let the watchdog fire and think() continue (state -> listening).
      await sleep(TIMEOUT_REAL_MS + 80);
      assert.equal(barges, 0);
      // The cascade window this covers: playbackOpen is false while audio
      // is still scheduled, and yield frames arrive while the agent holds
      // the floor (speaking/thinking).
      session.setState("speaking");

      // Residual window (3 s of audio out, window ends 4300): 24 voiced
      // frames — far more than sustain+effort — must NOT barge.
      setSpeech(true);
      await feedVoiced(session, DRAIN_AT_MS + 20, 3800);
      assert.equal(barges, 0, "residual audio must not barge the agent");
      assert.equal(softPauses, 0, "echo must not even raise a soft candidate");

      // Past the issued-audio horizon the SAME frames hard-yield.
      await feedVoiced(session, WINDOW_END_MS + 20, WINDOW_END_MS + 500);
      assert.ok(barges >= 1, "expected hard_yield after the audio horizon");
      assert.equal(session.getState(), "listening");
    } finally {
      off1();
      off2();
      session.reset();
    }
  });

  it("genuine playback_done clears the window so only the margin applies", async () => {
    const { session, setSpeech } = makeLiveSession();
    let starts = 0;
    const off = session.bus.on("speech_start", () => starts++);
    try {
      await speakTurn(session);
      // The client really drained: window is gone, not just decayed.
      session.onPlaybackDone(DRAIN_AT_MS);
      // think() re-arms listen at clientNow+arm (media t≈3100+700).
      await sleep(TIMEOUT_REAL_MS + 20);
      assert.equal(starts, 0);
      // A real utterance during the post-playback margin opens its turn —
      // the drained audio no longer suppresses (echoFloorAt is just the
      // static seed now).
      setSpeech(true);
      await feedVoiced(session, 3820, 4100);
      assert.ok(starts >= 1, "expected the utterance to open a turn");
    } finally {
      off();
      session.reset();
    }
  });

  it("drain timeout keeps the dynamic horizon in echoFloorAt until audio is truly out", async () => {
    const { session } = makeLiveSession();
    try {
      await speakTurn(session);
      await sleep(TIMEOUT_REAL_MS + 80);
      // Still inside the window: floor pinned at horizon + margin.
      assert.equal(session.echoFloorAt(DRAIN_AT_MS), WINDOW_END_MS);
      // Past the horizon: decays to t + margin only.
      assert.equal(session.echoFloorAt(WINDOW_END_MS + 10) - (WINDOW_END_MS + 10), MARGIN_MS);
    } finally {
      session.reset();
    }
  });
});

describe("session: clearConversation echo-state reset (F4)", () => {
  it("drops audioIssuedEndAt and bargeEchoUntil when wiping the conversation", async () => {
    const { session } = makeLiveSession();
    try {
      await speakTurn(session);
      assert.ok((session as unknown as { audioIssuedEndAt: number }).audioIssuedEndAt > 1700);
      // Synchronous prefix of clearConversation — before the confirmation
      // speak re-seeds the fields for the fresh turn.
      const done = session.clearConversation();
      const priv = session as unknown as {
        audioIssuedEndAt: number;
        bargeEchoUntil: number;
        playbackOpen: boolean;
      };
      assert.equal(priv.audioIssuedEndAt, 0, "stale audio horizon must drop");
      assert.equal(priv.bargeEchoUntil, 0, "stale echo seed must drop");
      assert.equal(priv.playbackOpen, false);
      await done;
    } finally {
      session.reset();
    }
  });
});

describe("session: schedule anchor with a stalled client clock (F6)", () => {
  it("never anchors issued audio at 0 when no client frame has established a media clock", async () => {
    const { session } = makeLiveSession();
    try {
      // t_ms=0 is ignored by clientNow (no client clock yet — mic stalled
      // before the first utterance).
      const serverBefore = performance.now();
      const flushed = new Promise<void>((resolve) => {
        const off = session.bus.on("tts_flush", () => {
          off();
          resolve();
        });
      });
      session.onTextUtterance("tell me something long", 0);
      await flushed;
      const endAt = (session as unknown as { audioIssuedEndAt: number })
        .audioIssuedEndAt;
      // Old behavior: 0 + durations only (~3000 media-ms from zero).
      // Fixed: anchored on the server clock, so the horizon is past
      // "now + durations", not collapsed toward 0.
      assert.ok(
        endAt >= serverBefore + CHUNKS * CHUNK_MS * 0.9,
        `horizon ${endAt} collapsed toward 0 (server now ${Math.round(serverBefore)})`,
      );
      const echoUntil = (session as unknown as { bargeEchoUntil: number })
        .bargeEchoUntil;
      assert.ok(echoUntil >= serverBefore);
    } finally {
      session.reset();
    }
  });
});
