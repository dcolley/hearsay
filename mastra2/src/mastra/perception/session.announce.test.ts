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
  opts?: {
    /** Record the text only when the fragment synthesises to completion
     * (an interrupted attempt leaves no trace in `spoken`). */
    logOnComplete?: boolean;
    /** Every synthesise call appends here the moment it starts. */
    started?: string[];
  },
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
        opts?.started?.push(text);
        if (opts?.logOnComplete) {
          // Completion marker sits AFTER the yield: a barge that breaks the
          // speak loop closes the generator, skipping it, so an interrupted
          // attempt leaves no trace in `spoken`.
          if (speakDelayRef.current > 0) await delay(speakDelayRef.current);
          yield { text, mime: "text/plain" };
          spoken.push(text);
          return;
        }
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

  it("mid-batch barge re-announces only the unfinished tail, each message exactly once", async () => {
    // Two queued results drain as one batch. A barge DURING the second
    // message must re-queue only what never spoke to the end: the first
    // message must never be re-announced (it already played in full) and the
    // interrupted second must land exactly once more. (Review finding: the
    // whole active batch used to go back, so the first message played twice.)
    const spoken: string[] = [];
    const started: string[] = [];
    const modeRef: { current: Mode } = { current: "reply" };
    const speakDelayRef = { current: 5 };
    const ALPHA = "Alpha result is ready.";
    const BETA = "Beta result is ready.";
    const session = makeSession(spoken, modeRef, makeEchoTool(50), speakDelayRef, {
      logOnComplete: true,
      started,
    });

    // Queue both results directly; a quiet room turns them into one batch.
    const t0 = Date.now();
    session.announceQueue.push({ id: "alpha-1", tool: "demo_echo", text: ALPHA }, t0);
    session.announceQueue.push({ id: "beta-1", tool: "demo_echo", text: BETA }, t0);

    // Alpha speaks to completion, then Beta starts (slowly) but has not.
    speakDelayRef.current = 400;
    await waitUntil(
      () => spoken.includes(ALPHA) && started.includes(BETA),
      4000,
      "alpha complete, beta started",
    );
    // Barge while the second message is mid-speak.
    session.bargeIn(Date.now());
    speakDelayRef.current = 5;

    // The unfinished tail comes back once: exactly one full delivery of each.
    await waitUntil(
      () => spoken.filter((s) => s === BETA).length === 1,
      5000,
      "beta re-announced to completion",
    );
    await delay(700);
    assert.deepEqual(
      spoken,
      [ALPHA, BETA],
      `each message exactly once across a mid-batch barge, got ${JSON.stringify(spoken)}`,
    );
    assert.equal(started.filter((s) => s === ALPHA).length, 1, "alpha never re-started");
    assert.equal(session.announceQueue.size(), 0);
  });

  it("reset() leaves no announce poll timer running; the next utterance re-arms it", async () => {
    // The poll interval is a setInterval per session: ws-server calls
    // reset() on WS close, and an interval surviving reset pins the closed
    // session for the process lifetime. Trap global interval creation.
    type Trap = { fires: number; cleared: boolean };
    const created = new Map<NodeJS.Timeout, Trap>();
    const origSet = globalThis.setInterval as unknown as (
      ...a: any[]
    ) => NodeJS.Timeout;
    const origClear = globalThis.clearInterval as unknown as (...a: any[]) => void;
    (globalThis as any).setInterval = (fn: () => void, ms: number) => {
      const id = origSet(() => {
        const trap = created.get(id);
        if (trap) trap.fires++;
        fn();
      }, ms);
      created.set(id, { fires: 0, cleared: false });
      return id;
    };
    (globalThis as any).clearInterval = (id: NodeJS.Timeout) => {
      const trap = created.get(id);
      if (trap) trap.cleared = true;
      return origClear(id);
    };
    try {
      const spoken: string[] = [];
      const session = makeSession(spoken, { current: "reply" }, makeEchoTool(50), {
        current: 5,
      });
      assert.equal(created.size, 1, "exactly one session interval (announce poll)");
      const [pollId] = [...created.keys()];
      const poll = created.get(pollId)!;
      await delay(200);
      assert.ok(poll.fires >= 1, "the poll timer is live before reset");

      session.reset();
      assert.equal(poll.cleared, true, "reset() must clearInterval the announce poll");
      const firesAtReset = poll.fires;
      await delay(300); // > 3 poll ticks (80 ms)
      assert.equal(poll.fires, firesAtReset, "no poll callback after reset");
      assert.equal(created.size, 1, "reset() must not re-arm immediately");

      // Lazy re-arm: the first utterance after a reset brings the poll back.
      session.onTextUtterance("re arm the poll timer", Date.now());
      assert.equal(created.size, 2, "next activity re-arms the poll");
      const rearmed = created.get([...created.keys()][1]!)!;
      await delay(200);
      assert.ok(rearmed.fires >= 1, "re-armed poll is live");
      session.reset();
    } finally {
      (globalThis as any).setInterval = origSet;
      (globalThis as any).clearInterval = origClear;
    }
  });
});
