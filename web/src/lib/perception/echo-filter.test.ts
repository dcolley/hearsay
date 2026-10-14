import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLikelyEcho, normalizeForCompare } from "./echo-filter";

describe("normalizeForCompare", () => {
  it("lowercases and strips punctuation", () => {
    assert.equal(
      normalizeForCompare("That's Enough!"),
      "thats enough",
    );
  });
});

describe("isLikelyEcho", () => {
  const tts =
    "I can deepen five tracks for you pick a number or say the label";

  it("flags exact / substring re-hearings", () => {
    assert.equal(isLikelyEcho("pick a number", tts), true);
    assert.equal(isLikelyEcho("I can deepen five tracks", tts), true);
  });

  it("flags high word overlap", () => {
    assert.equal(
      isLikelyEcho("deepen five tracks pick number", tts),
      true,
    );
  });

  it("flags short word bleed that appears in TTS", () => {
    assert.equal(isLikelyEcho("pick a number", tts), true);
    assert.equal(isLikelyEcho("five tracks", tts), true);
  });

  it("allows real user interrupts", () => {
    assert.equal(isLikelyEcho("stop talking please", tts), false);
    assert.equal(isLikelyEcho("what about transformers", tts), false);
  });

  it("empty spoken buffer is not echo", () => {
    assert.equal(isLikelyEcho("hello there", ""), false);
  });
});
