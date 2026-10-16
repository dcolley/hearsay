import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MastraDBMessage } from "@mastra/core/agent";
import {
  isNarratedSentence,
  stripNarrationFromMessage,
  stripNarrationFromText,
} from "./narration-guard.ts";

function assistantMessage(
  text: string,
  extraParts: Array<Record<string, unknown>> = [],
): MastraDBMessage {
  return {
    id: "m1",
    role: "assistant",
    content: {
      format: 2,
      parts: [{ type: "text", text }, ...extraParts],
      content: text,
    },
  } as unknown as MastraDBMessage;
}

function textOf(message: MastraDBMessage): string {
  const parts = (message as { content?: { parts?: Array<{ text?: string }> } })
    .content?.parts;
  return (parts ?? []).filter((p) => p?.text).map((p) => p.text).join(" ");
}

describe("stripNarrationFromText", () => {
  it("removes leading ack echoes", () => {
    assert.equal(
      stripNarrationFromText("Let me check. The weather is rain."),
      "The weather is rain.",
    );
  });

  it("removes tool lines and still-lines", () => {
    assert.equal(
      stripNarrationFromText("Searching the web. I found 3 results."),
      "I found 3 results.",
    );
    assert.equal(
      stripNarrationFromText(
        "Still working on it. Bear with me, almost there. All set.",
      ),
      "All set.",
    );
  });

  it("never strips narration words inside a longer sentence", () => {
    const text =
      "You are still working on it, aren't you? Here is the answer.";
    assert.equal(stripNarrationFromText(text), text);
    const question = "Are you still working on it?";
    assert.equal(stripNarrationFromText(question), question);
  });

  it("returns empty for pure narration", () => {
    assert.equal(stripNarrationFromText("Let me check."), "");
    assert.equal(stripNarrationFromText("Taking a look."), "");
  });

  it("is case- and punctuation-insensitive", () => {
    assert.ok(isNarratedSentence("let me check"));
    assert.ok(isNarratedSentence("  Still working on it. "));
    assert.ok(isNarratedSentence("Checking The Time."));
    assert.ok(!isNarratedSentence("Checking the status."));
  });
});

describe("stripNarrationFromMessage", () => {
  it("strips assistant messages only", () => {
    const user: MastraDBMessage = {
      id: "u1",
      role: "user",
      content: {
        format: 2,
        parts: [{ type: "text", text: "Let me check. What's the weather?" }],
        content: "Let me check. What's the weather?",
      },
    } as unknown as MastraDBMessage;
    assert.equal(stripNarrationFromMessage(user).content, user.content);
  });

  it("keeps non-text parts and rewrites the flattened content", () => {
    const toolPart = {
      type: "tool-invocation",
      toolInvocation: { toolCallId: "t", toolName: "get_weather", state: "result", result: {} },
    };
    const stripped = stripNarrationFromMessage(
      assistantMessage("Let me check. It is sunny today.", [toolPart]),
    );
    const content = (stripped as { content: { parts: Array<{ type: string; text?: string }>; content: string } }).content;
    assert.equal(content.parts[0]?.text, "It is sunny today.");
    assert.equal(content.parts[1]?.type, "tool-invocation");
    assert.equal(content.content, "It is sunny today.");
  });

  it("keeps a pure-echo message intact rather than storing an empty one", () => {
    const echo = assistantMessage("Still working on it.");
    assert.deepEqual(stripNarrationFromMessage(echo), echo);
  });

  it("drops text parts that are pure echo, keeps the rest", () => {
    const m = assistantMessage("Let me check.", []);
    const other = assistantMessage("Found it.", []);
    const combined: MastraDBMessage = {
      id: "m2",
      role: "assistant",
      content: {
        format: 2,
        parts: [
          ...(m.content as { parts: unknown[] }).parts,
          ...(other.content as { parts: unknown[] }).parts,
        ],
        content: "Let me check. Found it.",
      },
    } as unknown as MastraDBMessage;
    const stripped = stripNarrationFromMessage(combined);
    assert.equal(textOf(stripped), "Found it.");
  });
});
