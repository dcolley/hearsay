/**
 * Real-model integration: GatedTurnDetector driven by the actual
 * SmartTurnClassifier. Skipped when the model or golden fixtures are absent.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AdaptiveSilenceTurnDetector, GatedTurnDetector, type GateState } from "./turn.ts";
import { SmartTurnClassifier, defaultModelPath } from "./smart-turn.ts";

const GOLDEN_DIR = process.env.GOLDEN_DIR || "/home/derek/hearsay-work/golden";
const MODEL = defaultModelPath();

function readWav(name: string): Float32Array {
  const buf = readFileSync(`${GOLDEN_DIR}/wav_${name}.npy`);
  const off = buf[6] === 1 ? 10 + buf.readUInt16LE(8) : 12 + buf.readUInt32LE(8);
  const count = (buf.byteLength - off) / 4;
  return new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + count * 4));
}

const speechFrame = () => ({ isSpeech: true, energy: 0.1 });
const silenceFrame = () => ({ isSpeech: false, energy: 0 });

/** Wait until real ONNX inference settles the gate state. */
async function settle(gate: GatedTurnDetector, expect: GateState, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (gate.debugState() === expect) return;
    if (Date.now() - started > timeoutMs) {
      assert.fail(`gate stuck in ${gate.debugState()}, expected ${expect}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function openUtterance(gate: GatedTurnDetector): void {
  for (let t = 100; t <= 1000; t += 30) gate.onVad(speechFrame(), t);
  for (let t = 1120; t <= 1480; t += 30) gate.onVad(silenceFrame(), t);
}

describe("GatedTurnDetector with the real smart-turn model", {
  skip: !existsSync(MODEL) || !existsSync(`${GOLDEN_DIR}/wav_ramp.npy`),
}, () => {
  it("commits when the model agrees (complete utterance audio)", async () => {
    const classifier = await SmartTurnClassifier.create(MODEL);
    assert.ok(classifier);
    const gate = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), classifier, {
      graceMs: 600,
    });
    gate.setWindowProvider(() => readWav("ramp")); // p=0.98 -> agree
    openUtterance(gate);
    assert.equal(gate.onVad(silenceFrame(), 1550), false); // classified (real ONNX)
    await settle(gate, "commit-next");
    assert.equal(gate.onVad(silenceFrame(), 1580), true);
  });

  it("extends when the model disagrees (unfinished utterance audio)", async () => {
    const classifier = await SmartTurnClassifier.create(MODEL);
    assert.ok(classifier);
    const gate = new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), classifier, {
      graceMs: 600,
    });
    gate.setWindowProvider(() => readWav("sine_tail")); // p=0.069 -> disagree
    openUtterance(gate);
    assert.equal(gate.onVad(silenceFrame(), 1550), false);
    await settle(gate, "grace");
    // bounded: commit arrives at the grace expiry (t_ms frame-driven)
    let commit = false;
    for (let t = 1590; t <= 2200 && !commit; t += 30) commit = gate.onVad(silenceFrame(), t);
    assert.equal(commit, true);
  });
});
