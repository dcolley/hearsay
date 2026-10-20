import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpTtsAdapter,
  checkTtsEndpoint,
  ttsChunkDurationMs,
  type TtsChunk,
} from "./tts.ts";

const origFetch = globalThis.fetch;

function stubFetch(handler: (body: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
    handler(String(init?.body ?? ""))) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = origFetch;
}

describe("HttpTtsAdapter response formats", () => {
  it("default requests mp3 and yields audio/mpeg (Kokoro/Piper compat)", async () => {
    let body: { response_format?: string } | undefined;
    stubFetch((raw) => {
      body = JSON.parse(raw);
      return new Response(Buffer.from([1, 2, 3]));
    });
    const adapter = new HttpTtsAdapter("http://127.0.0.1:9", "sk-test", "tts-1", "af_heart");
    const chunks: TtsChunk[] = [];
    for await (const c of adapter.synthesize("hello there")) chunks.push(c);
    restoreFetch();
    assert.equal(body?.response_format, "mp3");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].mime, "audio/mpeg");
  });

  it("TTS_FORMAT=pcm requests pcm and yields 24 kHz L16 so durations derive", async () => {
    let body: { response_format?: string } | undefined;
    stubFetch((raw) => {
      body = JSON.parse(raw);
      // 4800 B = 100 ms of int16 mono at 24 kHz
      return new Response(Buffer.alloc(4800));
    });
    const adapter = new HttpTtsAdapter(
      "http://127.0.0.1:9",
      "sk-test",
      "tts-1",
      "Freya",
      "pcm",
    );
    const chunks: TtsChunk[] = [];
    for await (const c of adapter.synthesize("The postcode is SW1A 1AA.")) chunks.push(c);
    restoreFetch();
    assert.equal(body?.response_format, "pcm");
    assert.ok(chunks[0].mime!.toLowerCase().includes("l16"));
    assert.equal(ttsChunkDurationMs(chunks[0]), 100);
  });

  it("readback of TTS_FORMAT env applies when format arg is omitted", async () => {
    let body: { response_format?: string } | undefined;
    stubFetch((raw) => {
      body = JSON.parse(raw);
      return new Response(Buffer.alloc(2));
    });
    const prev = process.env.TTS_FORMAT;
    process.env.TTS_FORMAT = "pcm";
    try {
      const adapter = new HttpTtsAdapter("http://127.0.0.1:9", "sk-test");
      for await (const _c of adapter.synthesize("hi")) {
        /* drain */
      }
    } finally {
      if (prev === undefined) delete process.env.TTS_FORMAT;
      else process.env.TTS_FORMAT = prev;
      restoreFetch();
    }
    assert.equal(body?.response_format, "pcm");
  });

  it("stop() aborts an in-flight synthesis (barge-in contract)", async () => {
    // fetch that only settles when aborted — mirrors a slow sidecar interrupted.
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch;
    try {
      const adapter = new HttpTtsAdapter(
        "http://127.0.0.1:9",
        "sk-test",
        "tts-1",
        "Freya",
        "pcm",
      );
      const gen = adapter.synthesize("never finished") as AsyncGenerator<TtsChunk>;
      const pending = gen.next(); // generator is in the fetch await
      adapter.stop();
      const res = await pending;
      assert.equal(res.done, true);
    } finally {
      restoreFetch();
    }
  });
});

describe("ttsChunkDurationMs with an explicit rate=", () => {
  it("prefers rate= over PCM_SAMPLE_RATE (Phonon 24 kHz vs 16 kHz default)", () => {
    const chunk: TtsChunk = {
      audio: Buffer.alloc(9600),
      mime: "audio/L16; rate=24000; channels=1",
    };
    // 9600 B / (2 * 1 * 24 samples/ms) = 200 ms
    assert.equal(ttsChunkDurationMs(chunk), 200);
  });
});

describe("checkTtsEndpoint", () => {
  it("true when /health responds ok", async () => {
    stubFetch(() => new Response("{\"status\":\"ok\"}"));
    try {
      assert.equal(await checkTtsEndpoint("http://example.test/v1"), true);
    } finally {
      restoreFetch();
    }
  });

  it("false quickly when nothing listens", async () => {
    // Port 1 on loopback refuses instantly; must not hang past ~1 s.
    const started = Date.now();
    const ok = await checkTtsEndpoint("http://127.0.0.1:1");
    assert.equal(ok, false);
    assert.ok(Date.now() - started < 1500);
  });
});
