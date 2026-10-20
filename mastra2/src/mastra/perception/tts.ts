import { PCM_SAMPLE_RATE } from "./types.ts";

export interface TtsChunk {
  /** Raw audio bytes when available */
  audio?: Buffer;
  mime?: string;
  /** Speakable text for browser SpeechSynthesis fallback */
  text?: string;
}

export interface TtsAdapter {
  /**
   * Synthesize a sentence/fragment. May yield one or more chunks.
   * Prefer low first-audio latency (Kokoro/Piper-class).
   */
  synthesize(text: string): AsyncIterable<TtsChunk>;
  /** Hard cut — Step B barge-in; no-op for HTTP one-shots. */
  stop(): void;
}

/** Headerless int16 mono at 24 kHz — what Phonon serves for response_format=pcm. */
export const PCM_24K_MONO_MIME = "audio/L16; rate=24000; channels=1";

/** OpenAI-compatible POST {TTS_URL}/v1/audio/speech */
export class HttpTtsAdapter implements TtsAdapter {
  private aborted = false;
  private fetchAbort?: AbortController;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = process.env.OPENAI_API_KEY || "sk-dummy",
    private readonly model = process.env.TTS_MODEL || "tts-1",
    private readonly voice = process.env.TTS_VOICE || "af_heart",
    /** "mp3" (default, Kokoro/Piper) or "pcm" (Phonon sidecar, ADR-009). */
    private readonly format = (process.env.TTS_FORMAT || "mp3").toLowerCase(),
  ) {}

  async *synthesize(text: string): AsyncIterable<TtsChunk> {
    this.aborted = false;
    this.fetchAbort?.abort();
    this.fetchAbort = new AbortController();
    const trimmed = text.trim();
    if (!trimmed) return;

    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/audio/speech`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: trimmed,
          voice: this.voice,
          response_format: this.format === "pcm" ? "pcm" : "mp3",
        }),
        signal: this.fetchAbort.signal,
      });
    } catch (err) {
      if (this.aborted || (err instanceof Error && err.name === "AbortError")) {
        return;
      }
      throw err;
    }

    if (this.aborted) return;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TTS ${res.status}: ${body || res.statusText}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (this.aborted) return;
    yield {
      audio: buf,
      mime: this.format === "pcm" ? PCM_24K_MONO_MIME : "audio/mpeg",
      text: trimmed,
    };
  }

  stop(): void {
    this.aborted = true;
    this.fetchAbort?.abort();
  }
}

/** Sends text only — web client speaks via SpeechSynthesis. */
export class BrowserTtsAdapter implements TtsAdapter {
  private aborted = false;

  async *synthesize(text: string): AsyncIterable<TtsChunk> {
    this.aborted = false;
    const trimmed = text.trim();
    if (!trimmed || this.aborted) return;
    yield { text: trimmed };
  }

  stop(): void {
    this.aborted = true;
  }
}

/**
 * Playable duration (ms) this chunk adds when issued to the client, or null
 * when it cannot be derived. int16 PCM (mime audio/L16 with optional
 * rate=..., channels=..., or audio/pcm) and size-derived WAV are derivable;
 * MP3/Opus and text-only chunks are not, so callers fall back to the static
 * listen-arm.
 */
export function ttsChunkDurationMs(chunk: TtsChunk): number | null {
  const { audio, mime } = chunk;
  if (!audio || audio.byteLength === 0) return null;
  const m = (mime ?? "").toLowerCase();
  const rateMatch = /rate=(\d+)/.exec(m);
  const rate = rateMatch ? Number(rateMatch[1]) : PCM_SAMPLE_RATE;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const chMatch = /channels=(\d+)/.exec(m);
  const channels =
    chMatch && Number.isFinite(Number(chMatch[1])) && Number(chMatch[1]) > 0
      ? Number(chMatch[1])
      : 1;
  // Bytes consumed per millisecond across all channels.
  const bytesPerMs = 2 * channels * (rate / 1000);
  if (bytesPerMs <= 0) return null;
  if (m.includes("l16") || m.includes("pcm")) {
    return Math.floor(audio.byteLength / bytesPerMs);
  }
  if (m.includes("wav") && audio.byteLength > 44) {
    // RIFF container: assume the data chunk fills the rest (16-bit).
    return Math.floor((audio.byteLength - 44) / bytesPerMs);
  }
  return null;
}

/**
 * One-shot liveness check: GET {baseUrl}/health with a short budget.
 * True only on an HTTP response; false on refusal, timeout, or 4xx/5xx.
 */
export async function checkTtsEndpoint(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/health`;
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createTtsAdapter(): TtsAdapter {
  const mode = (process.env.TTS_MODE || "http").toLowerCase();
  if (mode === "browser") return new BrowserTtsAdapter();
  const url = process.env.TTS_URL?.trim();
  if (!url) {
    console.warn("[tts] TTS_URL unset — using browser text fallback");
    return new BrowserTtsAdapter();
  }
  // Boot probe: one warning line if nothing answers, so a dead sidecar fails
  // loudly instead of on every turn. Never blocks startup. (ADR-009)
  void checkTtsEndpoint(url).then((ok) => {
    if (!ok) {
      console.warn(
        `[tts] no endpoint answered ${url} — start the Phonon sidecar with ` +
          "`docker compose -f mastra2/docker/ptts/compose.yaml up -d`, " +
          "point TTS_URL at Kokoro/Piper, or set TTS_MODE=browser.",
      );
    }
  });
  return new HttpTtsAdapter(url);
}
