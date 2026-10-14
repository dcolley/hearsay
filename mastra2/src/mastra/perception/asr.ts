import { pcmRms } from "./content-gate.ts";
import { PCM_SAMPLE_RATE } from "./types.ts";

export interface AsrAdapter {
  /** Optional streaming partials while speech is ongoing. */
  feed?(pcm: Int16Array, t_ms: number): Promise<string | null>;
  /** Commit transcript for the utterance PCM buffer. */
  finalize(pcm: Int16Array): Promise<string>;
  reset(): void;
}

/** Below this duration / energy, mock ASR returns "" (no invented phrase). */
const MOCK_MIN_SAMPLES = Math.floor(PCM_SAMPLE_RATE * 0.4);
const MOCK_MIN_RMS = Number(process.env.ASR_MOCK_MIN_RMS || 0.012);

function int16ToWav(samples: Int16Array, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const dataSize = samples.byteLength;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(
    buffer,
    44,
  );
  return buffer;
}

/** OpenAI-compatible POST {ASR_URL}/v1/audio/transcriptions */
export class HttpAsrAdapter implements AsrAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = process.env.OPENAI_API_KEY || "sk-dummy",
    private readonly model = process.env.ASR_MODEL || "whisper-1",
  ) {}

  async finalize(pcm: Int16Array): Promise<string> {
    if (pcm.length === 0) return "";
    const wav = int16ToWav(pcm);
    const form = new FormData();
    form.append("model", this.model);
    const wavBytes = new Uint8Array(wav);
    form.append(
      "file",
      new Blob([wavBytes], { type: "audio/wav" }),
      "utterance.wav",
    );

    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ASR ${res.status}: ${text || res.statusText}`);
    }

    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }

  reset(): void {
    // Stateless HTTP finalize
  }
}

/** Loop-testing without a whisper sidecar. */
export class MockAsrAdapter implements AsrAdapter {
  constructor(
    private readonly phrase = process.env.ASR_MOCK_PHRASE ||
      "Hello Hearsay, can you hear me?",
  ) {}

  async finalize(pcm: Int16Array): Promise<string> {
    if (pcm.length < MOCK_MIN_SAMPLES) return "";
    if (pcmRms(pcm) < MOCK_MIN_RMS) return "";
    return this.phrase;
  }

  reset(): void {}
}

/** Client owns STT (Web Speech API) — never invent a phrase from PCM. */
export class NullAsrAdapter implements AsrAdapter {
  async finalize(_pcm: Int16Array): Promise<string> {
    return "";
  }
  reset(): void {}
}

export type AsrMode = "http" | "mock" | "browser";

export function resolveAsrMode(): AsrMode {
  const mode = (process.env.ASR_MODE || "http").toLowerCase();
  if (mode === "mock" || mode === "browser" || mode === "http") return mode;
  return "http";
}

export function createAsrAdapter(mode = resolveAsrMode()): AsrAdapter {
  if (mode === "mock") return new MockAsrAdapter();
  if (mode === "browser") {
    console.log("[asr] mode=browser — transcripts come from client Web Speech API");
    return new NullAsrAdapter();
  }
  const url = process.env.ASR_URL?.trim();
  if (!url) {
    console.warn(
      "[asr] ASR_URL unset — using browser-null adapter (no mock phrase). Set ASR_MODE=mock for loop tests, or ASR_MODE=browser + presence STT.",
    );
    return new NullAsrAdapter();
  }
  return new HttpAsrAdapter(url);
}
