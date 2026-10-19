/**
 * Memory hygiene (ADR-003): narration echoes must not survive a save/recall
 * round trip through the real HearsayMemory (real Memory + in-memory LibSQL).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { LibSQLStore } from "@mastra/libsql";
import { HearsayMemory } from "../memory/hearsay-memory.ts";

function newMemory(): HearsayMemory {
  return new HearsayMemory({
    storage: new LibSQLStore({ id: "hearsay-guard-test", url: ":memory:" }),
    options: {
      lastMessages: 24,
      observationalMemory: false,
      workingMemory: { enabled: false },
    },
  });
}

function msg(
  role: "user" | "assistant",
  text: string,
  threadId: string,
): Record<string, unknown> {
  return {
    id: randomUUID(),
    role,
    content: { format: 2, parts: [{ type: "text", text }], content: text },
    createdAt: new Date(),
    threadId,
    resourceId: "hearsay-test",
  };
}

const threadId = randomUUID();

describe("HearsayMemory narration guard", () => {
  it("strips narration echoes from assistant text on write", async () => {
    const memory = newMemory();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });
    const echo = msg(
      "assistant",
      "Let me check. It is 18 degrees and sunny.",
      threadId,
    );
    await memory.saveMessages({
      messages: [msg("user", "weather please", threadId), echo] as never,
    });

    const { messages } = await memory.recall({
      threadId,
      resourceId: "hearsay-test",
      perPage: 12,
    });
    const assistant = messages.filter((m) => m.role === "assistant");
    assert.equal(assistant.length, 1);
    const parts = (
      assistant[0] as { content: { parts: Array<{ text?: string }> } }
    ).content.parts;
    const text = parts.map((p) => p.text ?? "").join(" ");
    assert.equal(text, "It is 18 degrees and sunny.");
  });

  it("leaves clean messages and user text untouched", async () => {
    const memory = newMemory();
    const thread = randomUUID();
    await memory.createThread({ threadId: thread, resourceId: "hearsay-test", title: "t" });
    await memory.saveMessages({
      messages: [
        msg("user", "Searching the web for me, please.", thread),
        msg("assistant", "The capital of France is Paris.", thread),
      ] as never,
    });
    const { messages } = await memory.recall({
      threadId: thread,
      resourceId: "hearsay-test",
      perPage: 12,
    });
    const texts = messages
      .map((m) => {
        const parts = (
          m as unknown as { content: { parts: Array<{ text?: string }> } }
        ).content.parts;
        return parts.map((p) => p.text ?? "").join(" ");
      })
      .sort();
    assert.deepEqual(texts, [
      "Searching the web for me, please.",
      "The capital of France is Paris.",
    ]);
  });
});
