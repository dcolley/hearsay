import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
