/**
 * Speculative generation state machine + likely-EOU detector hook (ADR-007).
 *
 * Runs on injected fake timers so unit assertions are deterministic and
 * leak zero real handles. `openTimerCount()` is the leak tripwire: any
 * terminal transition must leave it at 0.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpeculativeTurn } from "./speculation.ts";
import { AdaptiveSilenceTurnDetector } from "./turn.ts";
import type { SpeculationTimers } from "./speculation.ts";

class FakeTimers implements SpeculationTimers {
  clock = 1000;
  private seq = 0;
  private due = new Map<number, { fn: () => void; at: number }>();
  created = 0;
  cleared = 0;

  now(): number {
    return this.clock;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.created++;
    const h = ++this.seq;
    this.due.set(h, { fn, at: this.clock + ms });
    return h;
  }
  clearTimeout(handle: unknown): void {
    if (this.due.delete(handle as number)) this.cleared++;
  }
  /** Advance the clock and fire everything due. */
  advance(ms: number): void {
    const target = this.clock + ms;
    const due = [...this.due.entries()].filter(([, e]) => e.at <= target);
    this.clock = target;
    for (const [h, e] of due) {
      if (this.due.delete(h)) e.fn();
    }
  }
  pending(): number {
    return this.due.size;
  }
}

describe("SpeculativeTurn state machine (ADR-007)", () => {
  it("idle -> speculative -> committed; timers cleared on commit", () => {
    const t = new FakeTimers();
    const spec = new SpeculativeTurn({ budgetMs: 5000, timers: t });
    assert.equal(spec.state, "idle");
    spec.begin(2400);
    assert.equal(spec.state, "speculative");
    assert.equal(spec.startedAt, 2400);
    assert.equal(spec.openTimerCount(), 1);
    assert.equal(spec.promote(), true);
    assert.equal(spec.state, "committed");
    assert.equal(spec.openTimerCount(), 0);
    assert.equal(t.pending(), 0);
    // terminal transitions are one-way
    assert.equal(spec.promote(), false);
    assert.equal(spec.discard(), false);
  });

  it("resume -> discarded: held buffer dropped, timers cleared", () => {
    const t = new FakeTimers();
    const spec = new SpeculativeTurn({ budgetMs: 5000, timers: t });
    spec.begin(100);
    spec.hold("First sentence.");
    spec.hold("Second sentence.");
    assert.equal(spec.held.length, 2);
    assert.equal(spec.discard(), true);
    assert.equal(spec.state, "discarded");
    assert.deepEqual(spec.held, []);
    assert.equal(spec.openTimerCount(), 0);
    assert.equal(t.pending(), 0);
  });

  it("commit promotes held sentences in order and drains the buffer", () => {
    const t = new FakeTimers();
    const spec = new SpeculativeTurn({ timers: t });
    spec.begin(0);
    spec.hold("one.");
    spec.hold("two.");
    const promoted = [...spec.held];
    assert.deepEqual(promoted, ["one.", "two."]);
    spec.promote();
    spec.drainHeld();
    assert.deepEqual(spec.held, []);
  });

  it("budget expiry fires exactly once and only while speculative", () => {
    const t = new FakeTimers();
    let expired = 0;
    const spec = new SpeculativeTurn({
      budgetMs: 1500,
      timers: t,
      onBudgetExpired: () => expired++,
    });
    spec.begin(0);
    t.advance(1500);
    assert.equal(expired, 1);
    assert.equal(t.pending(), 0);
    // a committed turn must not expire afterwards
    const spec2 = new SpeculativeTurn({
      budgetMs: 1500,
      timers: t,
      onBudgetExpired: () => expired++,
    });
    spec2.begin(0);
    spec2.promote();
    t.advance(10_000);
    assert.equal(expired, 1);
  });

  it("reset is always safe and returns to idle with an empty buffer", () => {
    const t = new FakeTimers();
    const spec = new SpeculativeTurn({ budgetMs: 5000, timers: t });
    spec.begin(0);
    spec.hold("orphan.");
    spec.reset();
    assert.equal(spec.state, "idle");
    assert.deepEqual(spec.held, []);
    assert.equal(t.pending(), 0);
    spec.begin(50);
    assert.equal(spec.state, "speculative");
  });

  it("fake-clock run leaves zero outstanding handles across begin/commit/discard cycles", () => {
    const t = new FakeTimers();
    for (let i = 0; i < 3; i++) {
      const a = new SpeculativeTurn({ budgetMs: 1000, timers: t });
      a.begin(t.now());
      a.hold("x.");
      a.promote();
      const b = new SpeculativeTurn({ budgetMs: 1000, timers: t });
      b.begin(t.now());
      b.discard();
      assert.equal(a.openTimerCount(), 0);
      assert.equal(b.openTimerCount(), 0);
    }
    assert.equal(t.pending(), 0);
    assert.equal(t.created, t.cleared);
  });
});

/** One 20 ms frame of detector input. */
function frames(
  det: AdaptiveSilenceTurnDetector,
  speech: boolean,
  fromT: number,
  count: number,
): number[] {
  const commits: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = fromT + i * 20;
    if (det.onVad({ isSpeech: speech, energy: speech ? 0.2 : 0 }, t)) {
      commits.push(t);
    }
  }
  return commits;
}

describe("AdaptiveSilenceTurnDetector likely-EOU hook (ADR-007)", () => {
  it("fires once per utterance inside the advance window, before commit", () => {
    const det = new AdaptiveSilenceTurnDetector({ speculativeAdvanceMs: 200 });
    const fired: number[] = [];
    det.setLikelyEouCallback((t) => fired.push(t));
    frames(det, true, 20, 110); // 2200 ms of speech
    assert.deepEqual(fired, [], "must not fire while speech is running");
    const commits = frames(det, false, 2220, 20); // up to t=2600
    assert.equal(fired.length, 1);
    assert.equal(fired[0], 2400); // advance window: 400 ms needed - 200 ms
    assert.equal(commits[0], 2600); // 2180 ms speech -> 400 ms silence
    frames(det, false, 2620, 10); // trailing silence must not re-fire
    assert.equal(fired.length, 1);
  });

  it("resumed speech re-arms the hook for the next quiet window", () => {
    const det = new AdaptiveSilenceTurnDetector({ speculativeAdvanceMs: 200 });
    const fired: number[] = [];
    det.setLikelyEouCallback((t) => fired.push(t));
    frames(det, true, 20, 110);
    frames(det, false, 2220, 12); // EOU fires around +200 ms
    assert.equal(fired.length, 1);
    frames(det, true, 2460, 10); // user resumes
    assert.equal(fired.length, 1);
    frames(det, false, 2660, 15); // quiet again -> may fire once more
    assert.equal(fired.length, 2);
  });

  it("onVad return values are unchanged when the hook is installed", () => {
    const plain = new AdaptiveSilenceTurnDetector({ speculativeAdvanceMs: 200 });
    const hooked = new AdaptiveSilenceTurnDetector({ speculativeAdvanceMs: 200 });
    hooked.setLikelyEouCallback(() => {});
    const trace = (d: AdaptiveSilenceTurnDetector): number[] => {
      const out: number[] = [];
      let t = 0;
      for (const [speech, n] of [
        [true, 110],
        [false, 15],
        [true, 8],
        [false, 30],
      ] as const) {
        for (let i = 0; i < n; i++, t += 20) {
          out.push(d.onVad({ isSpeech: speech, energy: speech ? 0.2 : 0 }, t) ? 1 : 0);
        }
      }
      return out;
    };
    assert.deepEqual(trace(hooked), trace(plain));
  });

  it("speculativeAdvanceMs=0 disables the hook entirely", () => {
    const det = new AdaptiveSilenceTurnDetector({ speculativeAdvanceMs: 0 });
    let fired = 0;
    det.setLikelyEouCallback(() => fired++);
    frames(det, true, 20, 110);
    const commits = frames(det, false, 2220, 20); // silentMs reaches 400 at t=2600
    assert.equal(fired, 0);
    assert.equal(commits[0], 2600, "normal commit still works");
  });
});
