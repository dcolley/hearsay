import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchChoiceResult } from "./client-bridge.ts";
import { parsePcmBinary, PCM_HEADER_BYTES } from "./types.ts";

describe("parsePcmBinary alignment", () => {
  it("accepts frames whose Buffer byteOffset is odd", () => {
    const samples = new Int16Array([100, -200, 300, -400]);
    const payload = Buffer.alloc(PCM_HEADER_BYTES + samples.byteLength);
    payload.writeBigUInt64LE(BigInt(1234), 0);
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(
      payload,
      PCM_HEADER_BYTES,
    );

    // Force odd byteOffset the way WS slices often do
    const padded = Buffer.concat([Buffer.from([0xff]), payload]);
    const sliced = padded.subarray(1);
    assert.equal(sliced.byteOffset % 2, 1);

    const frame = parsePcmBinary(sliced);
    assert.ok(frame);
    assert.equal(frame!.t_ms, 1234);
    assert.deepEqual([...frame!.samples], [100, -200, 300, -400]);
  });
});

describe("matchChoiceResult", () => {
  const choices = [
    "Transformers in depth",
    "Scaling and emergence",
    "Post-training",
  ];

  it("matches spoken numbers", () => {
    assert.equal(matchChoiceResult("two please", choices).index, 1);
    assert.equal(matchChoiceResult("I'll take 3", choices).choice, "Post-training");
  });

  it("matches ordinals and labels", () => {
    assert.equal(matchChoiceResult("the first one", choices).index, 0);
    assert.equal(
      matchChoiceResult("scaling and emergence", choices).index,
      1,
    );
  });
});
