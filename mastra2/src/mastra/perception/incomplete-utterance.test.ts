import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksIncompleteUtterance } from "./incomplete-utterance.ts";

describe("looksIncompleteUtterance", () => {
  it("flags trailing prepositions and articles", () => {
    assert.equal(looksIncompleteUtterance("What's the weather in"), true);
    assert.equal(looksIncompleteUtterance("Look at the"), true);
    assert.equal(looksIncompleteUtterance("Can you tell me about"), true);
  });

  it("flags trailing conjunctions", () => {
    assert.equal(looksIncompleteUtterance("I want coffee and"), true);
    assert.equal(looksIncompleteUtterance("Stop when"), true);
  });

  it("does not flag complete sentences", () => {
    assert.equal(
      looksIncompleteUtterance("What's the weather in London?"),
      false,
    );
    assert.equal(looksIncompleteUtterance("Stop."), false);
    assert.equal(looksIncompleteUtterance("What time is it"), false);
  });

  it("flags trailing comma", () => {
    assert.equal(looksIncompleteUtterance("First,"), true);
  });
});
