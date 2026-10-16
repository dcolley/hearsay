import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { PerceptionSession } from "./session.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StreamChunk = { type: string; payload?: unknown };

/**
 * Session-level integration: fake agent stream + fake TTS (records every
 * fragment it synthesises) so we can assert what the narrator actually said.
 */
function makeSession(
  spoken: string[],
  streamGen: (hooks: { session: PerceptionSession }) => AsyncGenerator<StreamChunk>,
  progress: {
    enabled?: boolean;
    ackAfterMs?: number;
    stillAfterMs?: number;
    maxStill?: number;
  },
) {
  const hooks: { session: PerceptionSession } = {} as { session: PerceptionSession };
  const gen = streamGen(hooks);

  const session = new PerceptionSession({
    agent: {
      stream: async () => ({ fullStream: gen }),
    } as unknown as Agent,
    memory: {} as Memory,
    vad: { process: () => ({ isSpeech: false, energy: 0 }), reset: () => {} },
    turn: { onVad: () => false, reset: () => {} },
    asr: { finalize: async () => "", reset: () => {} },
    tts: {
      synthesize: async function* (text: string) {
        spoken.push(text);
        yield { text, mime: "text/plain" };
      },
      stop: () => {},
    },
    vision: {
      getScene: () => ({
        at: 0,
        people: "",
        objects_changed: [],
        readouts: [],
        confidence: 0,
      }),
      onFrame: async () => null,
      reset: () => {},
    },
    clientOwnsAsr: true,
    listenArmMs: 1,
    progress,
  });
  hooks.session = session;
  return session;
}

/** Drive one spoken turn end-to-end and wait for it to settle. */
async function runTurn(session: PerceptionSession, text: string): Promise<void> {
  const flushed = new Promise<void>((resolve) => {
    const off = session.bus.on("tts_flush", () => {
      off();
      resolve();
    });
  });
  session.onTextUtterance(text, 1000);
  await flushed;
  session.onPlaybackDone(1e9);
  for (let i = 0; i < 500 && session.getState() !== "listening"; i++) {
    await delay(10);
  }
  await delay(20);
}

describe("session: progress speech (ADR-003)", () => {
  it("acks and keeps the user posted during a long, unknown-tool run", async () => {
    const spoken: string[] = [];
    const session = makeSession(
      spoken,
      async function* () {
        await delay(700);
        yield { type: "tool-call", payload: { toolName: "compute_heavy_thing" } };
        await delay(700);
        yield { type: "text-delta", payload: { text: "All done." } };
      },
      { enabled: true, ackAfterMs: 10, stillAfterMs: 400, maxStill: 3 },
    );

    await runTurn(session, "do the heavy thing");

    assert.ok(spoken.includes("Let me check."), `no ack in ${JSON.stringify(spoken)}`);
    assert.ok(
      spoken.includes("Still working on it."),
      `no still-line in ${JSON.stringify(spoken)}`,
    );
    assert.ok(spoken.includes("All done."), `no answer in ${JSON.stringify(spoken)}`);
    assert.ok(
      spoken.indexOf("Still working on it.") < spoken.indexOf("All done."),
      "narration must come before the answer, not after",
    );
  });

  it("speaks the tool line once, deduped across repeat calls", async () => {
    const spoken: string[] = [];
    const session = makeSession(
      spoken,
      async function* () {
        yield { type: "tool-call", payload: { toolName: "web_search" } };
        yield { type: "tool-result", payload: { toolName: "web_search" } };
        yield { type: "tool-call", payload: { toolName: "web_search" } };
        await delay(30);
        yield { type: "text-delta", payload: { text: "Here is what I found." } };
      },
      { enabled: true, ackAfterMs: 10, stillAfterMs: 400 },
    );

    await runTurn(session, "search for cats");

    assert.equal(
      spoken.filter((s) => s === "Searching the web.").length,
      1,
      `expected one deduped tool line, got ${JSON.stringify(spoken)}`,
    );
    assert.ok(spoken.includes("Here is what I found."));
  });

  it("stays fully silent when progress is disabled", async () => {
    const spoken: string[] = [];
    const session = makeSession(
      spoken,
      async function* () {
        await delay(700);
        yield { type: "tool-call", payload: { toolName: "web_search" } };
        await delay(700);
        yield { type: "text-delta", payload: { text: "All done." } };
      },
      { enabled: false },
    );

    await runTurn(session, "search for cats");

    assert.deepEqual(spoken, ["All done."]);
  });

  it("says nothing while ask_user waits — the question is the update", async () => {
    const spoken: string[] = [];
    const session = makeSession(
      spoken,
      async function* (hooks) {
        yield { type: "tool-call", payload: { toolName: "ask_user" } };
        // A pending HITL call marks the user as already answering.
        void hooks.session.bridge.call("ask_user", { question: "Which one?" });
        await delay(1100);
        hooks.session.bridge.resolveAskUserAnswer("the blue one");
        await delay(30);
        yield { type: "text-delta", payload: { text: "Blue it is." } };
      },
      { enabled: true, ackAfterMs: 10, stillAfterMs: 400 },
    );
    session.setClientActionSender(() => {});
    await runTurn(session, "what should I say back");

    assert.ok(!spoken.includes("Let me check."), `spurious ack in ${JSON.stringify(spoken)}`);
    assert.ok(
      !spoken.some((s) => /still working/i.test(s)),
      `spurious still-line in ${JSON.stringify(spoken)}`,
    );
    assert.ok(spoken.includes("Blue it is."));
  });
});
