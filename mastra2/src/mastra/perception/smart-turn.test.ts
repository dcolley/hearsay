/**
 * Smart-turn classifier tests. Real-model cases are guarded by file presence
 * so the default suite stays fast and model-independent.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaultModelPath, SmartTurnClassifier } from "./smart-turn.ts";

const GOLDEN_DIR = process.env.GOLDEN_DIR || "/home/derek/hearsay-work/golden";
const MODEL = defaultModelPath();

function readWav(name: string): Float32Array {
  const buf = readFileSync(`${GOLDEN_DIR}/wav_${name}.npy`);
  const off = buf[6] === 1 ? 10 + buf.readUInt16LE(8) : 12 + buf.readUInt32LE(8);
  const count = (buf.byteLength - off) / 4;
  return new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + count * 4));
}

const savedThreshold = process.env.SMART_TURN_THRESHOLD;
afterEach(() => {
  if (savedThreshold === undefined) delete process.env.SMART_TURN_THRESHOLD;
  else process.env.SMART_TURN_THRESHOLD = savedThreshold;
});

describe("SmartTurnClassifier (model-independent)", () => {
  it("create() returns null for a missing model path", async () => {
    const classifier = await SmartTurnClassifier.create(join(tmpdir(), "no-such-model-9f3a.onnx"));
    assert.equal(classifier, null);
  });

  it("create() returns null when the model file exists but is not ONNX", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearsay-model-"));
    const junk = join(dir, "junk.onnx");
    writeFileSync(junk, "not an onnx model");
    const classifier = await SmartTurnClassifier.create(junk);
    assert.equal(classifier, null);
  });
});

describe("SmartTurnClassifier (golden model)", { skip: !existsSync(MODEL) || !existsSync(`${GOLDEN_DIR}/wav_ramp.npy`) }, () => {
  it("classifies golden windows as the model does", async () => {
    const classifier = await SmartTurnClassifier.create(MODEL);
    assert.ok(classifier);
    assert.equal(await classifier!.isEndOfTurn(readWav("ramp")), true);
    assert.equal(await classifier!.isEndOfTurn(readWav("silence")), true);
    assert.equal(await classifier!.isEndOfTurn(readWav("sine_tail")), false);
  });

  it("SMART_TURN_THRESHOLD raises the bar", async () => {
    process.env.SMART_TURN_THRESHOLD = "0.99";
    const classifier = await SmartTurnClassifier.create(MODEL);
    assert.ok(classifier);
    assert.equal(await classifier!.isEndOfTurn(readWav("ramp")), false); // 0.98 < 0.99
    process.env.SMART_TURN_THRESHOLD = "0.05";
    const lenient = await SmartTurnClassifier.create(MODEL);
    assert.ok(lenient);
    assert.equal(await lenient!.isEndOfTurn(readWav("sine_tail")), true); // 0.069 > 0.05
  });

  it("serializes concurrent calls onto the session", async () => {
    const classifier = await SmartTurnClassifier.create(MODEL);
    assert.ok(classifier);
    const results = await Promise.all([
      classifier!.isEndOfTurn(readWav("ramp")),
      classifier!.isEndOfTurn(readWav("silence")),
      classifier!.isEndOfTurn(readWav("sine_tail")),
    ]);
    assert.deepEqual(results, [true, true, false]);
  });

  it("short windows work (zero-padded tail path)", async () => {
    const classifier = await SmartTurnClassifier.create(MODEL);
    assert.ok(classifier);
    assert.equal(await classifier!.isEndOfTurn(readWav("short3s")), true);
  });
});
