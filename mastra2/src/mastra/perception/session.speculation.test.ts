/**
 * Session-level speculation integration (ADR-007).
 *
 * Drives the PCM path (ASR_MODE=http|mock shape: the session owns ASR):
 * real AdaptiveSilenceTurnDetector so likely-EOU and commit fire at their
 * natural frame times, a stub agent.stream() that records its options and
 * persists mid-stream the way the real loop does, a real HearsayMemory so
 * recall() proves the write gate, and a fake TTS that records every
 * fragment it synthesises.
 *
 * Fixture phrases avoid needsScreenshot/needsLiveVision/wantsOfferChoices
 * (no "colour", "look", "pick a") so speculation is allowed to run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { PerceptionSession } from "./session.ts";
import { AdaptiveSilenceTurnDetector } from "./turn.ts";
import { HearsayMemory } from "../memory/hearsay-memory.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESOURCE_ID = "spec-test";

type Chunk = { type: string; payload?: unknown };
type StreamCall = { toolChoice?: unknown; abortSignal?: AbortSignal };

/**
 * Per-finalize-call ASR outcomes (fix round, IMPORTANT-1): an item is either
 * a literal transcript or an outcome applied to the matching call:
 * `delayMs` (realistic slow finalize so the outcome lands while commitTurn
 * awaits spec.finalized), `error` (reject), `text` (""). The last item repeats
 * for later calls - that models the ordinary commit re-finalizing after a
 * discarded speculation attempt ended.
 */
type AsrOutcome = string | { text?: string; error?: string; delayMs?: number };

function msg(role: "user" | "assistant", text: string, threadId: string) {
  return {
    id: randomUUID(),
    role,
    content: { format: 2, parts: [{ type: "text", text }], content: text },
    createdAt: new Date(),
    threadId,
    resourceId: RESOURCE_ID,
  };
}

function harness(cfg: {
  /** What the mock ASR hears (same result every finalize call). */
  asrText: string;
  /** Text the stream yields on confirmed (non-speculative) turns. */
  liveDeltas: string[];
  /** Speculative variant instead ends in a tool-call. */
  specToolCall?: boolean;
  /** Per-call finalize outcomes (defaults to [asrText] repeated). */
  asrSeq?: AsrOutcome[];
}) {
  const spoken: string[] = [];
  const calls: StreamCall[] = [];
  const weather: { effects: number } = { effects: 0 };
  const vadCtl = { speech: false };
  let finalizeCalls = 0;

  const memory = new HearsayMemory({
    storage: new LibSQLStore({ id: `spec-${randomUUID()}`, url: ":memory:" }),
    options: {
      lastMessages: 24,
      observationalMemory: false,
      workingMemory: { enabled: false },
    },
  });

  const session = new PerceptionSession({
    agent: {
      stream: async (_messages: unknown, options?: StreamCall) => {
        calls.push({ ...(options ?? {}) });
        const specMode = options?.toolChoice === "none";
        const signal = options?.abortSignal;
        const threadId = session.threadId;
        const gen = (async function* (): AsyncGenerator<Chunk> {
          if (signal?.aborted) return;
          // The real stream loop persists user + assistant mid-stream; this
          // stub persists up front, which is what the write gate must catch.
          await memory.saveMessages({
            messages: [
              msg("user", cfg.asrText, threadId),
              msg("assistant", cfg.liveDeltas.join(""), threadId),
            ] as never,
          });
          if (!specMode) weather.effects++;
          if (specMode && cfg.specToolCall) {
            // Model wants a tool despite toolChoice:"none".
            yield { type: "text-delta", payload: { text: "One moment. " } };
            yield {
              type: "tool-call",
              payload: { toolName: "weather", args: { city: "here" } },
            };
            return;
          }
          for (const d of cfg.liveDeltas) {
            if (signal?.aborted) return;
            yield { type: "text-delta", payload: { text: d } };
          }
        })();
        return { fullStream: gen };
      },
    } as unknown as Agent,
    memory: memory as unknown as Memory,
    vad: {
      process: () => ({ isSpeech: vadCtl.speech, energy: vadCtl.speech ? 0.2 : 0 }),
      reset: () => {},
    },
    turn: new AdaptiveSilenceTurnDetector(),
    asr: {
      finalize: async () => {
        const seq = cfg.asrSeq ?? [cfg.asrText];
        const item = seq[Math.min(finalizeCalls, seq.length - 1)];
        finalizeCalls++;
        if (typeof item !== "string") {
          if (item.delayMs) await delay(item.delayMs);
          if (item.error) throw new Error(item.error);
          return item.text ?? "";
        }
        return item;
      },
      reset: () => {},
    },
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
    clientOwnsAsr: false,
    resourceId: RESOURCE_ID,
    listenArmMs: 1,
    sustainMs: 100,
    progress: { enabled: false },
  });

  const rows = async (): Promise<string[]> => {
    const { messages } = await memory.recall({
      threadId: session.threadId,
      resourceId: RESOURCE_ID,
      perPage: 24,
    });
    return messages.map((m) => {
      const parts = (
        m as unknown as { content: { parts?: Array<{ type?: string; text?: string }> } }
      ).content.parts;
      return (parts ?? [])
        .filter((p) => p?.type === "text")
        .map((p) => p.text ?? "")
        .join("");
    });
  };

  const feed = async (speech: boolean, fromT: number, count: number) => {
    vadCtl.speech = speech;
    for (let i = 0; i < count; i++) {
      await session.onAudio({ t_ms: fromT + i * 20, samples: new Int16Array(320) });
    }
  };

  return {
    session,
    memory,
    spoken,
    calls,
    rows,
    feed,
    finalizeCalls: () => finalizeCalls,
    weather,
  };
}

type H = ReturnType<typeof harness>;

/** Resolve once the session is back to listening (or fail loudly). */
async function waitListening(h: H): Promise<void> {
  for (let i = 0; i < 400 && h.session.getState() !== "listening"; i++) {
    await delay(5);
  }
  assert.equal(h.session.getState(), "listening");
}

/**
 * Complete a 2200 ms turn: speech, silence, likely-EOU, commit. Then the
 * spoken answer flushes and the session returns to listening.
 */
async function driveCompleteTurn(h: H): Promise<void> {
  const flushed = new Promise<void>((resolve) => {
    const off = h.session.bus.on("tts_flush", () => {
      off();
      resolve();
    });
  });
  await h.feed(true, 20, 110); // 2200 ms speech
  await h.feed(false, 2220, 25); // quiet: EOU at +200, commit at +400
  await Promise.race([
    flushed,
    delay(6000).then(() => {
      throw new Error("timed out waiting for tts_flush");
    }),
  ]);
  h.session.onPlaybackDone(1e9);
  await waitListening(h);
}

/**
 * Same turn but the user resumes at resumeAt (100 ms of extra silence per
 * frame beyond that). The commit then happens ~400 ms after the last frame.
 */
async function driveResumedTurn(h: H, resumeAt: number): Promise<void> {
  const flushed = new Promise<void>((resolve) => {
    const off = h.session.bus.on("tts_flush", () => {
      off();
      resolve();
    });
  });
  await h.feed(true, 20, 110);
  await h.feed(false, 2220, (resumeAt - 2220) / 20);
  await delay(40); // let the speculative stream persist + generate in flight
  await h.feed(true, resumeAt, 10); // user resumes
  await h.feed(false, resumeAt + 200, 45); // quiet -> second attempt commits
  await Promise.race([
    flushed,
    delay(6000).then(() => {
      throw new Error("timed out waiting for tts_flush");
    }),
  ]);
  h.session.onPlaybackDone(1e9);
  await waitListening(h);
}

function useSpecEnv(run: () => Promise<void>, speculateMs = "1500"): Promise<void> {
  const keys = ["SPECULATE_MS", "SPECULATE_ADVANCE_MS"];
  const prev = keys.map((k) => [k, process.env[k]] as const);
  process.env.SPECULATE_MS = speculateMs;
  process.env.SPECULATE_ADVANCE_MS = "200";
  return run().finally(() => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("session: speculative generation (ADR-007)", () => {
  it("commit path: held chunks speak in order, exactly one memory write", async () => {
    await useSpecEnv(async () => {
      const h = harness({
        asrText: "what is two plus two",
        liveDeltas: ["The answer is two. ", "It checks out."],
      });
      await h.memory.createThread({
        threadId: h.session.threadId,
        resourceId: RESOURCE_ID,
        title: "spec",
      });
      const flushed = new Promise<void>((resolve) => {
        const off = h.session.bus.on("tts_flush", () => {
          off();
          resolve();
        });
      });

      // 110 frames of speech, then silence up to (not past) the EOU frame.
      await h.feed(true, 20, 110);
      assert.equal(h.session.debugSpeculation(), "idle", "no speculation during speech");
      await h.feed(false, 2220, 10); // last frame t=2400 -> likely-EOU fires
      assert.equal(h.session.debugSpeculation(), "speculative");
      assert.equal(h.session.getState(), "listening", "speculation alone does not flip state");

      // Let the speculative stream run (persist + generate) while uncommitted.
      await delay(80);
      assert.deepEqual(h.spoken, [], "speculative sentences must never be spoken");
      assert.deepEqual(await h.rows(), [], "blocked writes must not reach storage");
      assert.equal(h.calls.filter((c) => c.toolChoice === "none").length, 1);
      assert.equal(h.finalizeCalls(), 1, "ASR finalized early, once");

      // Now the quiet keeps running and the detector commits at t=2600.
      await h.feed(false, 2420, 12);
      await Promise.race([
        flushed,
        delay(6000).then(() => {
          throw new Error("timed out waiting for tts_flush");
        }),
      ]);
      h.session.onPlaybackDone(1e9);
      await waitListening(h);

      assert.equal(h.calls.length, 1, "the stream ran once, promoted at commit");
      assert.deepEqual(h.spoken, ["The answer is two.", "It checks out."]);
      assert.deepEqual(await h.rows(), [
        "what is two plus two",
        "The answer is two. It checks out.",
      ]);
      assert.equal(h.finalizeCalls(), 1, "commit did not re-run ASR");
    });
  });

  it("resume before commit: discarded run leaves zero rows, turn commits normally", async () => {
    await useSpecEnv(async () => {
      const h = harness({
        asrText: "what is two plus two",
        liveDeltas: ["The answer is two. ", "It checks out."],
      });
      await h.memory.createThread({
        threadId: h.session.threadId,
        resourceId: RESOURCE_ID,
        title: "spec",
      });
      await driveResumedTurn(h, 2500);

      // First attempt ran speculatively (toolChoice none) and persisted into
      // the gate - the discard must drop those rows.
      assert.ok(
        h.calls.some((c) => c.toolChoice === "none"),
        "first attempt must have run speculatively",
      );
      assert.equal(h.spoken.join(" "), "The answer is two. It checks out.");
      // Exactly one user + one assistant - nothing left from the discarded run.
      assert.deepEqual(await h.rows(), [
        "what is two plus two",
        "The answer is two. It checks out.",
      ]);
    });
  });

  it("tool-intent fixture: provider ignoring toolChoice:'none' -> discard, normal commit re-runs", async () => {
    await useSpecEnv(async () => {
      // A phrase with NO server/client tool markers: speculation is allowed to
      // run, the stream signals tool intent anyway, and the accepted discard
      // fallback must still commit the turn exactly once.
      const h = harness({
        asrText: "what is two plus two",
        liveDeltas: ["The answer is two. "],
        specToolCall: true,
      });
      await h.memory.createThread({
        threadId: h.session.threadId,
        resourceId: RESOURCE_ID,
        title: "spec",
      });
      await driveCompleteTurn(h);

      assert.equal(h.calls[0]!.toolChoice, "none", "speculative stream had tools disabled");
      assert.equal(h.calls.filter((c) => c.toolChoice === "none").length, 1);
      assert.equal(h.calls.filter((c) => c.toolChoice !== "none").length, 1);
      assert.equal(h.weather.effects, 1, "effect executed exactly once, post-commit");
      assert.equal(h.spoken.join(" "), "The answer is two.");
      assert.deepEqual(await h.rows(), [
        "what is two plus two",
        "The answer is two.",
      ]);
    });
  });

  it("server-tool fixture (weather): speculation skipped at the gate, tool runs once normally", async () => {
    await useSpecEnv(async () => {
      // IMPORTANT-2 (a): weather phrasing matches the server-tool exclusion,
      // so no speculative stream may start at all - the turn goes straight
      // through the ordinary path where the tool actually executes.
      const h = harness({
        asrText: "what is the weather in london today",
        liveDeltas: ["It is twenty one degrees and sunny."],
        specToolCall: true, // if speculation DID run, this is what it would do
      });
      await h.memory.createThread({
        threadId: h.session.threadId,
        resourceId: RESOURCE_ID,
        title: "spec",
      });
      await driveCompleteTurn(h);

      assert.equal(
        h.calls.filter((c) => c.toolChoice === "none").length,
        0,
        "server-tool utterances must never start a speculative stream",
      );
      assert.equal(h.calls.filter((c) => c.toolChoice !== "none").length, 1);
      assert.equal(h.weather.effects, 1, "weather effect executed exactly once, post-commit");
      assert.equal(h.spoken.join(" "), "It is twenty one degrees and sunny.");
      assert.deepEqual(await h.rows(), [
        "what is the weather in london today",
        "It is twenty one degrees and sunny.",
      ]);
    });
  });
});

/**
 * IMPORTANT-1 (review fix): every way a speculation attempt can END while
 * commitTurn awaits spec.finalized (needs-effects / empty / asr-error /
 * budget expiry) must hand the turn back to the ordinary commit path, which
 * runs exactly once - never stall, never double-commit. The ASR finalize is
 * delayed so the outcome lands during the commit await (the race the old
 * `if (this.spec !== spec) return;` guard lost the confirmed turn on).
 */
describe("session: speculation ending during commit-await (ADR-007 fix round)", () => {
  async function expectOrdinaryCommitAfterAttemptEnded(
    cfg: Parameters<typeof harness>[0],
    speculateMs: string,
  ): Promise<void> {
    await useSpecEnv(async () => {
      const h = harness(cfg);
      await h.memory.createThread({
        threadId: h.session.threadId,
        resourceId: RESOURCE_ID,
        title: "spec",
      });
      await driveCompleteTurn(h);

      const expected = h.spoken.join(" ");
      assert.ok(expected.length > 0, "the ordinary commit must still speak");
      const rows = await h.rows();
      assert.equal(rows.length, 2, "exactly one user + one assistant pair persisted");
      assert.equal(rows[0], cfg.asrText);
      assert.equal((rows[1] ?? "").trim(), cfg.liveDeltas.join("").trim());
      assert.equal(h.session.getState(), "listening", "turn must not stall");
      assert.equal(
        h.calls.filter((c) => c.toolChoice === "none").length,
        0,
        "an attempt that ended in a discard must never have promoted a stream",
      );
    }, speculateMs);
  }

  it("needs-effects discard during commit-await -> ordinary commit", async () => {
    await expectOrdinaryCommitAfterAttemptEnded(
      {
        asrText: "what does my screen say right now",
        liveDeltas: ["The screen shows a blank desktop."],
        // first finalize (speculative) resolves LATE with a needsScreenshot
        // transcript -> discarded at the exclusions gate while commit awaits.
        asrSeq: [{ text: "what does my screen say right now", delayMs: 60 }, "what does my screen say right now"],
      },
      "1500",
    );
  });

  it("empty-transcript discard during commit-await -> ordinary commit re-runs ASR", async () => {
    await expectOrdinaryCommitAfterAttemptEnded(
      {
        asrText: "what is two plus two",
        liveDeltas: ["The answer is two. "],
        asrSeq: [{ text: "", delayMs: 60 }, "what is two plus two"],
      },
      "1500",
    );
  });

  it("asr-error discard during commit-await -> ordinary commit re-runs ASR", async () => {
    await expectOrdinaryCommitAfterAttemptEnded(
      {
        asrText: "what is two plus two",
        liveDeltas: ["The answer is two. "],
        asrSeq: [{ error: "finalize boom", delayMs: 60 }, "what is two plus two"],
      },
      "1500",
    );
  });

  it("budget-expiry discard during commit-await -> ordinary commit", async () => {
    await expectOrdinaryCommitAfterAttemptEnded(
      {
        asrText: "what is two plus two",
        liveDeltas: ["The answer is two. "],
        // finalize resolves after the (60 ms) budget has already expired.
        asrSeq: [{ text: "what is two plus two", delayMs: 150 }, "what is two plus two"],
      },
      "60",
    );
  });
});
