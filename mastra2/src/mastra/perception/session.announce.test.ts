import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { z } from "zod";
import { withToolContract } from "../tools/with-contract.ts";
import { PerceptionSession } from "./session.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  fn: () => boolean,
  ms = 4000,
  what = "condition",
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Test-only demo async tool (registered nowhere in production): the
 * "background job" resolves after `jobMs` and the formatted result goes to
 * the session's AnnounceQueue via requestContext, exactly like a real async
 * tool inside a real agent stream.
 */
function makeEchoTool(jobMs: number) {
  return withToolContract({
    id: "demo_echo",
    description: "Echo text back in the background (integration fixture).",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    kind: "async",
    formatResult: (out: unknown) => (out as { text: string }).text,
    execute: async (input: { text: string }) => {
      await delay(jobMs);
      return { text: `Echo: ${input.text}` };
    },
  });
}

type Mode = "echo" | "reply";

/**
 * Session-level integration (fake agent stream + recording fake TTS): an
 * async tool result interrupted mid-reply waits in the queue, speaks exactly
 * once at the next silent moment, and is re-queued (not lost) when the
 * announce itself is barged. All timings injected via SessionDeps like
 * progress ack/still.
 */
function makeSession(
  spoken: string[],
  modeRef: { current: Mode },
  echoTool: ReturnType<typeof withToolContract>,
  speakDelayRef: { current: number },
) {
  const hooks: { session: PerceptionSession } = {} as {
    session: PerceptionSession;
  };

  async function* streamGen(
    hooksRef: { session: PerceptionSession },
  ): AsyncGenerator<{ type: string; payload?: unknown }> {
    if (modeRef.current === "echo") {
      yield { type: "tool-call", payload: { toolName: "demo_echo" } };
      void (
        echoTool as unknown as {
          execute: (a: unknown, c: unknown) => Promise<unknown>;
        }
      ).execute(
        { text: "the background job" },
        { requestContext: hooksRef.session.debugRequestContext() },
      );
      yield { type: "text-delta", payload: { text: "Working on it." } };
      // Keep the stream alive until the session interrupts it.
      for (let i = 0; i < 40; i++) {
        await delay(50);
        yield { type: "tool-result", payload: { toolName: "noop" } };
      }
      yield { type: "text-delta", payload: { text: "This part never arrives." } };
      return;
    }
    // Short complete turn used between announce attempts.
    yield { type: "text-delta", payload: { text: "Okay." } };
    return;
  }

  const gen = streamGen(hooks) as AsyncGenerator<{
    type: string;
    payload?: unknown;
  }>;

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
        // A slow fake voice keeps a fragment speaking long enough to barge
        // mid-announce when the test wants that.
        if (speakDelayRef.current > 0) await delay(speakDelayRef.current);
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
    bargeInEnabled: true,
    listenArmMs: 1,
    playbackDoneTimeoutMs: 400,
    progress: { enabled: false },
    announce: { silenceMs: 1200, ttlMs: 120_000, pollMs: 80 },
  });
  hooks.session = session;

  // The Presence client is implicit: answer every tts_flush with
  // playback_done shortly after, like a real browser would.
  session.bus.on("tts_flush", ({ t_ms }) => {
    setTimeout(() => session.onPlaybackDone(t_ms + 5), 10);
  });
  return session;
}

describe("session: deferred announcements (ADR-008)", () => {
  it("interrupted stream -> result announced exactly once after 1.3 s of silence", async () => {
    const spoken: string[] = [];
    const echo = makeEchoTool(150);
    const modeRef: { current: Mode } = { current: "echo" };
    const session = makeSession(spoken, modeRef, echo, { current: 5 });

    session.onTextUtterance("start echo now", 1000);
    await waitUntil(
      () => spoken.includes("Working on it."),
      2000,
      "first reply fragment",
    );

    // Interrupt mid-reply.
    session.bargeIn(1400);

    // Nothing is announced while we have only just interrupted.
    await delay(600);
    assert.equal(
      spoken.filter((s) => s.startsWith("Echo:")).length,
      0,
      `announced too early in ${JSON.stringify(spoken)}`,
    );

    // After >=1.2 s of quiet it must land, exactly once.
    await waitUntil(
      () => spoken.filter((s) => s === "Echo: the background job").length === 1,
      4000,
      "single announce",
    );
    await delay(700);
    assert.equal(spoken.filter((s) => s.startsWith("Echo:")).length, 1);

    // The interrupted stream's continuation never leaked.
    assert.ok(!spoken.includes("This part never arrives."));
    assert.equal(session.announceQueue.size(), 0);
  });

  it("interrupting the announce itself re-queues without loss", async () => {
    const spoken: string[] = [];
    const echo = makeEchoTool(300);
    const modeRef: { current: Mode } = { current: "echo" };
    // Slow fragments so the second barge can land mid-announce.
    const speakDelayRef = { current: 300 };
    const session = makeSession(spoken, modeRef, echo, speakDelayRef);

    session.onTextUtterance("start echo now", 1000);
    await waitUntil(
      () => spoken.includes("Working on it."),
      2000,
      "first reply fragment",
    );
    session.bargeIn(1600);

    // Wait for the announce to start speaking.
    await waitUntil(
      () => spoken.filter((s) => s.startsWith("Echo:")).length >= 1,
      5000,
      "announce started",
    );
    // The fragment is still synthesising (300 ms) - barge DURING the
    // announce: it must not be lost.
    session.bargeIn(1900);
    await waitUntil(() => session.announceQueue.size() >= 1, 1000, "re-queued");

    // It comes back and is spoken again at the next quiet moment.
    speakDelayRef.current = 5;
    await waitUntil(
      () => spoken.filter((s) => s.startsWith("Echo:")).length === 2,
      5000,
      "re-announced",
    );
    await delay(500);
    assert.equal(spoken.filter((s) => s.startsWith("Echo:")).length, 2);
    assert.equal(session.announceQueue.size(), 0, "queue must finally drain empty");
  });
});
