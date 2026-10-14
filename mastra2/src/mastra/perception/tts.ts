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

/** OpenAI-compatible POST {TTS_URL}/v1/audio/speech */
export class HttpTtsAdapter implements TtsAdapter {
  private aborted = false;
  private fetchAbort?: AbortController;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = process.env.OPENAI_API_KEY || "sk-dummy",
    private readonly model = process.env.TTS_MODEL || "tts-1",
    private readonly voice = process.env.TTS_VOICE || "af_heart",
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
          response_format: "mp3",
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
    yield { audio: buf, mime: "audio/mpeg", text: trimmed };
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

export function createTtsAdapter(): TtsAdapter {
  const mode = (process.env.TTS_MODE || "http").toLowerCase();
  if (mode === "browser") return new BrowserTtsAdapter();
  const url = process.env.TTS_URL?.trim();
  if (!url) {
    console.warn("[tts] TTS_URL unset — using browser text fallback");
    return new BrowserTtsAdapter();
  }
  return new HttpTtsAdapter(url);
}
