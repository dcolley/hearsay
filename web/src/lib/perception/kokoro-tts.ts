/**
 * In-browser Kokoro-82M TTS (same stack as kokoroweb.app / kokoro-js).
 * Client-only — never import from server components.
 */

export type KokoroLoadStatus =
  | { state: "idle" }
  | { state: "loading"; message: string; progress?: number }
  | { state: "ready"; device: string }
  | { state: "error"; message: string };

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Common Kokoro English voices (subset of kokoro-js VOICES). */
export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: "af_heart", label: "Heart (US female)" },
  { id: "af_bella", label: "Bella (US female)" },
  { id: "af_nicole", label: "Nicole (US female)" },
  { id: "af_sarah", label: "Sarah (US female)" },
  { id: "af_sky", label: "Sky (US female)" },
  { id: "am_michael", label: "Michael (US male)" },
  { id: "am_adam", label: "Adam (US male)" },
  { id: "am_echo", label: "Echo (US male)" },
  { id: "bf_emma", label: "Emma (UK female)" },
  { id: "bf_isabella", label: "Isabella (UK female)" },
  { id: "bm_george", label: "George (UK male)" },
  { id: "bm_lewis", label: "Lewis (UK male)" },
];

type KokoroInstance = {
  generate: (
    text: string,
    opts?: { voice?: string; speed?: number },
  ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
  voices: Record<string, { name?: string }>;
};

let instance: KokoroInstance | null = null;
let loadPromise: Promise<KokoroInstance> | null = null;
let status: KokoroLoadStatus = { state: "idle" };
const listeners = new Set<(s: KokoroLoadStatus) => void>();

function setStatus(next: KokoroLoadStatus): void {
  status = next;
  for (const cb of listeners) cb(next);
}

export function getKokoroStatus(): KokoroLoadStatus {
  return status;
}

export function onKokoroStatus(
  cb: (s: KokoroLoadStatus) => void,
): () => void {
  listeners.add(cb);
  cb(status);
  return () => listeners.delete(cb);
}

async function detectDevice(): Promise<"webgpu" | "wasm"> {
  try {
    if (typeof navigator !== "undefined" && "gpu" in navigator) {
      const adapter = await (
        navigator as Navigator & {
          gpu?: { requestAdapter: () => Promise<unknown> };
        }
      ).gpu?.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {
    // fall through
  }
  return "wasm";
}

export async function preloadKokoro(): Promise<void> {
  await getKokoro();
}

async function getKokoro(): Promise<KokoroInstance> {
  if (instance) return instance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    setStatus({ state: "loading", message: "Loading Kokoro…", progress: 0 });
    const device = await detectDevice();
    const dtype = device === "webgpu" ? "fp32" : "q8";

    // Dynamic import keeps SSR / Node bundling away from onnxruntime-web
    const { KokoroTTS } = await import("kokoro-js");

    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype,
      device,
      progress_callback: (info) => {
        const prog =
          typeof info === "object" &&
          info &&
          "progress" in info &&
          typeof (info as { progress?: number }).progress === "number"
            ? (info as { progress: number }).progress
            : undefined;
        const statusText =
          typeof info === "object" &&
          info &&
          "status" in info &&
          typeof (info as { status?: string }).status === "string"
            ? (info as { status: string }).status
            : "Downloading model…";
        setStatus({
          state: "loading",
          message: statusText,
          progress: prog,
        });
      },
    });

    const wrapped: KokoroInstance = {
      voices: tts.voices as Record<string, { name?: string }>,
      generate: async (text, opts) => {
        const raw = await tts.generate(text, {
          voice: (opts?.voice || "af_heart") as "af_heart",
          speed: opts?.speed ?? 1,
        });
        // RawAudio from transformers.js
        const audio = (raw as { audio?: Float32Array }).audio;
        const sampling_rate =
          (raw as { sampling_rate?: number }).sampling_rate ?? 24000;
        if (!audio) {
          throw new Error("Kokoro returned empty audio");
        }
        return { audio, sampling_rate };
      },
    };

    instance = wrapped;
    setStatus({ state: "ready", device });
    return wrapped;
  })().catch((err) => {
    loadPromise = null;
    const message = err instanceof Error ? err.message : String(err);
    setStatus({ state: "error", message });
    throw err;
  });

  return loadPromise;
}

/** Synthesize text to a blob: URL suitable for HTMLAudioElement. */
export async function synthesizeKokoroUrl(
  text: string,
  opts?: { voice?: string; speed?: number },
): Promise<string> {
  const tts = await getKokoro();
  const { audio, sampling_rate } = await tts.generate(text, opts);
  const blob = float32ToWavBlob(audio, sampling_rate);
  return URL.createObjectURL(blob);
}

function float32ToWavBlob(
  samples: Float32Array,
  sampleRate: number,
): Blob {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
