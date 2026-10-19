/**
 * GatedTurnDetector tests: semantic gate behaviour over AdaptiveSilenceTurnDetector
 * with stub classifiers. Timing is frame-driven (t_ms), no real clocks.
 *
 * Timeline helper: speech 100..1000 ms (900 ms sustained -> base needs 550 ms
 * silence -> base alone would commit at t=1550), openUtterance() feeds only up
 * to 1480 so each test triggers the commit itself.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VadResult } from "./vad.ts";
import { AdaptiveSilenceTurnDetector, GatedTurnDetector } from "./turn.ts";

const speechFrame = (): VadResult => ({ isSpeech: true, energy: 0.1 });
const silenceFrame = (): VadResult => ({ isSpeech: false, energy: 0 });

type Verdict = boolean | null;

class StubClassifier {
  calls = 0;
  /** Queued per-call outcomes; "hold" parks the promise until resolveNext. */
  queue: (Verdict | "throw" | "hold")[] = [];
  private parked: ((v: Verdict) => void)[] = [];

  isEndOfTurn(): Promise<boolean | null> {
    this.calls += 1;
    const outcome = this.queue.shift() ?? null;
    if (outcome === "throw") return Promise.reject(new Error("classifier boom"));
    if (outcome === "hold") {
      return new Promise<Verdict>((resolve) => {
        this.parked.push(resolve);
      });
    }
    return Promise.resolve(outcome);
  }

  resolveNext(v: Verdict): void {
    this.parked.shift()?.(v);
  }
}

/** Speech 100..1000, silence 1120..1480 (base does NOT commit yet). */
function openUtterance(det: GatedTurnDetector | AdaptiveSilenceTurnDetector): void {
  for (let t = 100; t <= 1000; t += 30) det.onVad(speechFrame(), t);
  for (let t = 1120; t <= 1480; t += 30) det.onVad(silenceFrame(), t);
}

/** Pump microtasks so promise-chain classifier verdicts land. */
async function pump(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("GatedTurnDetector", () => {
  it("classifier null: passes base through bit-identically", () => {
    const gated = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), null);
    const bare = new AdaptiveSilenceTurnDetector();
    for (let t = 0; t < 3000; t += 30) {
      const s = t % 120 < 60;
      assert.equal(
        gated.onVad({ isSpeech: s, energy: s ? 0.1 : 0 }, t),
        bare.onVad({ isSpeech: s, energy: s ? 0.1 : 0 }, t),
        `t=${t}`,
      );
    }
  });

  it("agree verdict commits on the next onVad call", async () => {
    const stub = new StubClassifier();
    stub.queue.push(true);
    const det = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), stub, { graceMs: 600 });
    openUtterance(det);
    assert.equal(det.onVad(silenceFrame(), 1550), false); // gated: base true swallowed
    assert.equal(stub.calls, 1);
    await pump();
    assert.equal(det.onVad(silenceFrame(), 1580), true); // agree -> commit
    assert.equal(det.onVad(silenceFrame(), 1610), false); // quiet again
  });

  it("disagree verdict extends by graceMs then commits", async () => {
    const stub = new StubClassifier();
    stub.queue.push(false);
    const det = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), stub, { graceMs: 600 });
    openUtterance(det);
    assert.equal(det.onVad(silenceFrame(), 1550), false);
    await pump(); // verdict: disagree -> base reset + grace window (from 1550)
    assert.equal(det.onVad(silenceFrame(), 1580), false);
    assert.equal(det.onVad(silenceFrame(), 2100), false); // 550 < 600
    assert.equal(det.onVad(silenceFrame(), 2160), true); // bounded: 610 >= graceMs
  });

  it("speech resume before verdict cancels pending state", async () => {
    const stub = new StubClassifier();
    stub.queue.push("hold", true);
    const det = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), stub, { graceMs: 600 });
    openUtterance(det);
    assert.equal(det.onVad(silenceFrame(), 1550), false); // classifier parked
    // user resumes speech before the verdict lands
    assert.equal(det.onVad(speechFrame(), 1560), false);
    stub.resolveNext(true); // late agree must NOT commit (stale generation)
    await pump();
    // new speech + silence cycle runs a fresh classification
    for (let t = 1590; t <= 2600; t += 30) det.onVad(speechFrame(), t);
    let commit = false;
    for (let t = 2630; t <= 3150 && !commit; t += 30) commit = det.onVad(silenceFrame(), t);
    assert.equal(stub.calls, 2);
    if (!commit) {
      await pump();
      commit = det.onVad(silenceFrame(), 3170);
    }
    assert.equal(commit, true);
  });

  it("second disagree commits immediately (bounded, no deadlock)", async () => {
    const stub = new StubClassifier();
    stub.queue.push(false, false);
    const det = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), stub, { graceMs: 600 });
    openUtterance(det);
    assert.equal(det.onVad(silenceFrame(), 1550), false);
    await pump();
    // speech resumes during the extended grace window
    for (let t = 1560; t <= 2700; t += 30) det.onVad(speechFrame(), t);
    let sawCommit = false;
    for (let t = 2730; t < 3300 && !sawCommit; t += 30) sawCommit = det.onVad(silenceFrame(), t);
    // base said true again at ~3250 -> second classification queued
    await pump();
    // second disagreement commits without another grace wait
    assert.equal(det.onVad(silenceFrame(), 3310), true);
  });

  it("classifier throw resolves null -> passthrough (commit anyway)", async () => {
    const stub = new StubClassifier();
    stub.queue.push("throw");
    const det = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), stub, { graceMs: 600 });
    openUtterance(det);
    assert.equal(det.onVad(silenceFrame(), 1550), false);
    await pump();
    assert.equal(det.onVad(silenceFrame(), 1580), true);
  });

  it("reset clears gate state so the next cycle starts clean", async () => {
    const stub = new StubClassifier();
    stub.queue.push(false, true);
    const det = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), stub, { graceMs: 600 });
    openUtterance(det);
    assert.equal(det.onVad(silenceFrame(), 1550), false);
    await pump();
    det.reset();
    // fresh cycle: speech 100..1000 -> base commits at t=1550 (550 ms after 1000)
    for (let t = 100; t <= 1000; t += 30) det.onVad(speechFrame(), t);
    for (let t = 1030; t <= 1530; t += 30) assert.equal(det.onVad(silenceFrame(), t), false);
    assert.equal(stub.calls, 1);
    assert.equal(det.onVad(silenceFrame(), 1550), false); // second classification queued
    assert.equal(stub.calls, 2);
    await pump();
    assert.equal(det.onVad(silenceFrame(), 1580), true);
  });

  it("getters: classifierMissing true only when gate on without classifier", () => {
    const missing = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), null);
    assert.equal(missing.classifierMissing, true);
    const ok = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), new StubClassifier());
    assert.equal(ok.classifierMissing, false);
  });
});
