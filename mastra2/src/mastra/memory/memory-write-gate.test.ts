/**
 * Memory write gate (ADR-007 step 1). Two routes must be gated:
 *
 * 1. The HearsayMemory.saveMessages subclass override (direct API).
 * 2. The stream shortcut: agent.stream() persists via
 *    MessageHistory.persistMessages straight into the storage memory
 *    domain, bypassing Memory.saveMessages entirely (the
 *    mastra-ai/mastra#22873 bug shape). A console-trace spike over
 *    @mastra/memory 1.37 proved this; the real-stream test below is that
 *    spike pinned as a regression test - if the domain wrapper were ever
 *    removed, that test fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import { LibSQLStore } from "@mastra/libsql";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { HearsayMemory } from "../memory/hearsay-memory.ts";

function newMemory(): HearsayMemory {
  return new HearsayMemory({
    storage: new LibSQLStore({ id: "hearsay-gate-test", url: ":memory:" }),
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

async function texts(
  memory: HearsayMemory,
  threadId: string,
): Promise<string[]> {
  const { messages } = await memory.recall({
    threadId,
    resourceId: "hearsay-test",
    perPage: 24,
  });
  return messages.map((m) => {
    const parts = (
      m as unknown as { content: { parts?: Array<{ text?: string; type?: string }> } }
    ).content.parts;
    return (parts ?? [])
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  });
}

describe("HearsayMemory write gate (ADR-007)", () => {
  it("blocked saveMessages persists nothing, recall shows nothing", async () => {
    const memory = newMemory();
    const threadId = randomUUID();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });

    memory.blockWrites(true);
    assert.equal(memory.writesBlocked, true);
    const res = await memory.saveMessages({
      messages: [msg("user", "speculative question", threadId), msg("assistant", "speculative answer", threadId)] as never,
    });
    // no-op-shaped result: messages echoed back, nothing stored
    assert.equal(res.messages.length, 2);
    assert.deepEqual(await texts(memory, threadId), []);
  });

  it("flushPending persists buffered writes in original order", async () => {
    const memory = newMemory();
    const threadId = randomUUID();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });

    memory.blockWrites(true);
    await memory.saveMessages({ messages: [msg("user", "one", threadId)] as never });
    await memory.saveMessages({ messages: [msg("assistant", "two", threadId)] as never });
    await memory.saveMessages({ messages: [msg("user", "three", threadId)] as never });
    memory.blockWrites(false);

    assert.deepEqual(await texts(memory, threadId), []);
    await memory.flushPending();
    assert.deepEqual(await texts(memory, threadId), ["one", "two", "three"]);

    // pending list is drained - a second flush writes nothing new
    await memory.flushPending();
    assert.deepEqual(await texts(memory, threadId), ["one", "two", "three"]);
  });

  it("clearPending drops everything: nothing lands later", async () => {
    const memory = newMemory();
    const threadId = randomUUID();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });

    memory.blockWrites(true);
    await memory.saveMessages({ messages: [msg("user", "gone", threadId)] as never });
    memory.clearPending();
    memory.blockWrites(false);
    await memory.flushPending();
    assert.deepEqual(await texts(memory, threadId), []);

    // gate opens fully: normal writes work again
    await memory.saveMessages({ messages: [msg("user", "fresh", threadId)] as never });
    assert.deepEqual(await texts(memory, threadId), ["fresh"]);
  });

  it("agent.stream writes land in the gate (storage-domain spike)", async () => {
    const memory = newMemory();
    const threadId = randomUUID();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });
    const agent = new Agent({
      id: "gate-stream",
      name: "Gate Stream",
      instructions: "Say hello.",
      model: createMockModel({ mockText: "Hello there. All good.", version: "v2" }) as any,
      memory,
    });

    // Unblocked control: the stream path persists normally (two rows).
    const s0 = await agent.stream("control turn", {
      memory: { thread: threadId, resource: "hearsay-test" },
    } as any);
    for await (const _c of s0.fullStream) { /* drain */ }
    await s0.text;
    assert.equal((await texts(memory, threadId)).length, 2);

    // Speculative: blocked gate must catch BOTH stream writes - they do not
    // go through Memory.saveMessages (spike: MessageHistory.persistMessages
    // -> storage domain), so only the domain wrapper stops them.
    memory.blockWrites(true);
    try {
      const s1 = await agent.stream("speculative turn", {
        memory: { thread: threadId, resource: "hearsay-test" },
      } as any);
      const chunks: string[] = [];
      for await (const c of s1.fullStream) chunks.push(c.type);
      assert.match(chunks.join(","), /text-delta/);
      await s1.text;
      await new Promise((r) => setTimeout(r, 150));
      // still exactly the two control rows - speculation leaked nothing
      assert.equal((await texts(memory, threadId)).length, 2);
    } finally {
      memory.blockWrites(false);
    }

    // Committing promotes the speculative write: exactly one user + one
    // assistant row for the speculative turn, in order.
    await memory.flushPending();
    const all = await texts(memory, threadId);
    assert.equal(all.length, 4);
    assert.deepEqual(all.slice(2), ["speculative turn", "Hello there. All good."]);
  });

  it("flushAndUnblock: a write racing the flush lands in-order at this commit", async () => {
    const memory = newMemory();
    const threadId = randomUUID();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });

    memory.blockWrites(true);
    await memory.saveMessages({ messages: [msg("user", "one", threadId), msg("assistant", "two", threadId)] as never });

    // The flush is in flight when a stream write races the commit (the old
    // flush->unblock gap left this write either late or dropped).
    const flush = memory.flushAndUnblock();
    await memory.saveMessages({ messages: [msg("user", "racer", threadId)] as never });
    await flush;

    assert.deepEqual(await texts(memory, threadId), ["one", "two", "racer"]);
    assert.equal(memory.writesBlocked, false, "the gate is fully open afterwards");

    // writes land normally again immediately - same turn, nothing dropped
    await memory.saveMessages({ messages: [msg("user", "four", threadId)] as never });
    assert.deepEqual(await texts(memory, threadId), ["one", "two", "racer", "four"]);
  });

  it("awaiting ensureWriteGate before the first stream keeps the domain route gated", async () => {
    // Minor-1: blockWrites(true) installs the storage-domain wrapper in the
    // background; a stream started without awaiting it could escape the gate.
    const store = new LibSQLStore({ id: "hearsay-gate-test", url: ":memory:" });
    const memory = new HearsayMemory({
      storage: store,
      options: { lastMessages: 24, observationalMemory: false, workingMemory: { enabled: false } },
    });
    const threadId = randomUUID();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });

    memory.blockWrites(true);
    await memory.ensureWriteGate();

    const domain = (await store.getStore("memory")) as unknown as {
      saveMessages: (args: { messages: unknown }) => Promise<unknown>;
    };
    assert.ok(domain.saveMessages, "storage domain exposes saveMessages (the stream shortcut)");
    await domain.saveMessages({ messages: [msg("user", "escaped write", threadId)] });
    assert.deepEqual(await texts(memory, threadId), [], "the install must complete before the first stream write");
  });

  it("unblocked behaviour is bit-identical to the narration guard (ADR-003)", async () => {
    const memory = newMemory();
    const threadId = randomUUID();
    await memory.createThread({ threadId, resourceId: "hearsay-test", title: "t" });
    await memory.saveMessages({
      messages: [msg("assistant", "Let me check. It is 18 degrees and sunny.", threadId)] as never,
    });
    assert.deepEqual(await texts(memory, threadId), ["It is 18 degrees and sunny."]);
  });
});
