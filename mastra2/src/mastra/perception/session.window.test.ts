/**
 * Session gate-window tests: appendWindow / getUtteranceWindow driven
 * directly (not via setWindowProvider), the 8 s cap and drop-oldest
 * behaviour, windowReset at beginListenArm, and the metric-hook wiring.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { PerceptionSession } from "./session.ts";

const WINDOW = 16_000 * 8;

interface WindowInternals {
  appendWindow(samples: Int16Array): void;
  windowSamples: number;
  beginListenArm(t_ms: number): void;
}

function internals(session: PerceptionSession): WindowInternals {
  return session as unknown as WindowInternals;
}

function makeSession(turnExtra: object = {}): PerceptionSession {
  const session = new PerceptionSession({
    agent: {
      stream: async () => ({ fullStream: (async function* () {})() }),
    } as unknown as Agent,
    memory: {} as Memory,
    vad: { process: () => ({ isSpeech: false, energy: 0 }), reset: () => {} },
    turn: { onVad: () => false, reset: () => {}, ...turnExtra },
    asr: { finalize: async () => "", reset: () => {} },
    tts: {
      synthesize: async function* (text: string) {
        yield { text, mime: "text/plain" };
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
    listenArmMs: 1,
  });
  return session;
}

describe("session utterance window (gate)", () => {
  it("keeps appended frames verbatim at the tail, zeros elsewhere", () => {
    const session = makeSession();
    internals(session).appendWindow(new Int16Array(1000).fill(111));
    internals(session).appendWindow(new Int16Array(1000).fill(222));
    const w = session.getUtteranceWindow();
    assert.equal(w.length, WINDOW);
    // Front-padded: everything before the two frames is zero.
    for (let i = 0; i < WINDOW - 2000; i++) assert.equal(w[i], 0, `index ${i}`);
    // Frame order preserved at the tail (this is what the classifier sees).
    for (let i = 0; i < 1000; i++) {
      assert.equal(w[WINDOW - 2000 + i], 111 / 32768, `frame1[${i}]`);
      assert.equal(w[WINDOW - 1000 + i], 222 / 32768, `frame2[${i}]`);
    }
  });

  it("appending past 8 s drops the OLDEST samples", () => {
    const session = makeSession();
    internals(session).appendWindow(new Int16Array(1600).fill(1));
    internals(session).appendWindow(new Int16Array(1600).fill(2));
    internals(session).appendWindow(new Int16Array(126000).fill(3));
    assert.equal(internals(session).windowSamples, WINDOW);
    const w = session.getUtteranceWindow();
    assert.equal(w.length, WINDOW);
    // Kept = last 128000: 400 of chunk1, all of chunk2, all of chunk3.
    for (let i = 0; i < 400; i++) assert.equal(w[i], 1 / 32768, `head[${i}]`);
    for (let i = 400; i < 2000; i++) assert.equal(w[i], 2 / 32768, `mid[${i}]`);
    for (let i = 2000; i < WINDOW; i++) assert.equal(w[i], 3 / 32768, `tail[${i}]`);
  });

  it("the counter never exceeds the cap, however many appends", () => {
    const session = makeSession();
    for (let i = 0; i < 45; i++) {
      // 45 x 3200 = 144000 > 128000: the cap must bite.
      internals(session).appendWindow(new Int16Array(3200).fill(9));
      assert.ok(
        internals(session).windowSamples <= WINDOW,
        `after append ${i}: ${internals(session).windowSamples}`,
      );
    }
    assert.equal(internals(session).windowSamples, WINDOW);
    const w = session.getUtteranceWindow();
    assert.equal(w[0], 9 / 32768);
    assert.equal(w[WINDOW - 1], 9 / 32768);
  });

  it("empty appends are no-ops and the window starts all-zero", () => {
    const session = makeSession();
    internals(session).appendWindow(new Int16Array(0));
    assert.equal(internals(session).windowSamples, 0);
    const w = session.getUtteranceWindow();
    assert.equal(w.length, WINDOW);
    assert.ok(w.every((v) => v === 0));
  });

  it("beginListenArm resets the gate window", () => {
    const session = makeSession();
    internals(session).appendWindow(new Int16Array(100).fill(7));
    assert.equal(internals(session).windowSamples, 100);
    internals(session).beginListenArm(1000);
    assert.equal(internals(session).windowSamples, 0);
    assert.ok(session.getUtteranceWindow().every((v) => v === 0));
  });

  it("session wires setWindowProvider AND setMetricHook on a gated turn", () => {
    let windowProviderFn: (() => Float32Array) | undefined;
    let hookWired = false;
    makeSession({
      setWindowProvider: (fn: () => Float32Array) => {
        windowProviderFn = fn;
      },
      setMetricHook: (fn: unknown) => {
        hookWired = typeof fn === "function";
      },
      classifierMissing: false,
    });
    assert.equal(typeof windowProviderFn, "function");
    assert.equal(hookWired, true, "setMetricHook must be called so gate diagnostics reach metrics");
  });
});
