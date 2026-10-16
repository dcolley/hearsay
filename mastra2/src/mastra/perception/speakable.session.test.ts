/**
 * Speakable guard through a real session (ADR-004): CJK drift from the model
 * must never reach TTS, and a wholly-unreadable answer must get the polite
 * fallback rather than silence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { PerceptionSession } from "./session.ts";
import { NOT_CAUGHT } from "./speakable.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StreamChunk = { type: string; payload?: unknown };

function makeSession(
  spoken: string[],
  chunks: StreamChunk[],
) {
  const session = new PerceptionSession({
    agent: {
      stream: async () => ({
        fullStream: (async function* () {
          for (const chunk of chunks) {
            await delay(5);
            yield chunk;
          }
        })(),
      }),
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
    progress: { enabled: false },
  });
  return session;
}

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

describe("session: speakable guard (ADR-004)", () => {
  it("drops CJK from the answer but speaks the readable remainder", async () => {
    const spoken: string[] = [];
    const session = makeSession(spoken, [
      { type: "text-delta", payload: { text: "The forecast is rain. 好的，没问题。" } },
    ]);

    await runTurn(session, "what is the forecast tomorrow");

    assert.ok(spoken.length > 0);
    assert.ok(!spoken.some((s) => /[\u3400-\u9fff]/.test(s)), `CJK spoken: ${JSON.stringify(spoken)}`);
    assert.ok(spoken.join(" ").includes("forecast is rain"), `spoken: ${JSON.stringify(spoken)}`);
    assert.ok(!spoken.includes(NOT_CAUGHT));
  });

  it("speaks the polite fallback when the whole answer is unreadable", async () => {
    const spoken: string[] = [];
    const session = makeSession(spoken, [
      { type: "text-delta", payload: { text: "抱歉，我无法理解这段语音。" } },
    ]);

    await runTurn(session, "hello there can you hear me");

    assert.deepEqual(spoken, [NOT_CAUGHT]);
  });
});
