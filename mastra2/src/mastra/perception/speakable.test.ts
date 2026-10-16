import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOT_CAUGHT,
  dropUnreadableScripts,
  hasUnreadableScript,
  isSpeakable,
} from "./speakable.ts";
import { toSpokenReply } from "./reply-text.ts";

describe("speakable guard (ADR-004)", () => {
  it("drops CJK and keeps the readable remainder", () => {
    assert.equal(dropUnreadableScripts("你好, the answer is 42."), "the answer is 42.");
    assert.equal(dropUnreadableScripts("日本語のテキスト"), "");
    assert.equal(dropUnreadableScripts("한국어 텍스트"), "");
    assert.equal(dropUnreadableScripts("ＡＢＣ ｏｎｌｙ ｆｕｌｌ"), "");
  });

  it("detects unreadable script (for metrics) without mutating", () => {
    assert.ok(hasUnreadableScript("mixed text 文本"));
    assert.ok(!hasUnreadableScript("clean english text"));
  });

  it("isSpeakable needs real pronounceable characters", () => {
    assert.ok(isSpeakable("Hello 123"));
    assert.ok(!isSpeakable("   "));
    assert.ok(!isSpeakable("，。！"));
  });

  it("toSpokenReply applies the guard end to end", () => {
    assert.equal(toSpokenReply("Sure. The result is 5. 好的。"), "Sure. The result is 5.");
    assert.equal(toSpokenReply("抱歉，我无法回答"), "");
  });

  it("NOT_CAUGHT is an English sentence with a friendly shape", () => {
    assert.ok(isSpeakable(NOT_CAUGHT));
  });
});
