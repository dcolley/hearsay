/**
 * In-browser Pocket TTS (Kyutai via pocket-tts-js).
 * Built-in voices + optional zero-shot clone from a short reference clip.
 * Client-only — never import from server components.
 */

import {
  getPocketClone,
  savePocketClone,
  newCloneId,
  type PocketCloneRecord,
} from "./pocket-voice-store";

export type PocketLoadStatus =
  | { state: "idle" }
  | { state: "loading"; message: string; progress?: number }
  | { state: "ready"; cloning: boolean }
  | { state: "error"; message: string };

/** Common English built-ins (actual list comes from the bundle after load). */
export const POCKET_FALLBACK_VOICES: { id: string; label: string }[] = [
  { id: "alba", label: "Alba" },
  { id: "azelma", label: "Azelma" },
  { id: "cosette", label: "Cosette" },
  { id: "javert", label: "Javert" },
];

type PocketInstance = {
  sampleRate: number;
  predefinedVoices: string[];
  loadVoice: (name: string) => Promise<string>;
  cloneVoice: (
    audio: Float32Array,
    opts?: { inputSampleRate?: number; name?: string },
  ) => Promise<string>;
  generate: (
    text: string,
    opts: {
      voice: string;
      onChunk?: (audio: Float32Array) => void;
    },
  ) => Promise<unknown>;
  stop: () => Promise<void>;
  destroy: () => void;
};

let instance: PocketInstance | null = null;
/** True when the loaded instance downloaded the mimi encoder. */
let instanceHasCloning = false;
let loadPromise: Promise<PocketInstance> | null = null;
let status: PocketLoadStatus = { state: "idle" };
const listeners = new Set<(s: PocketLoadStatus) => void>();
/** cloneId / builtin name → worker voice ref for this session */
const preparedRefs = new Map<string, string>();

function setStatus(next: PocketLoadStatus): void {
  status = next;
  for (const cb of listeners) cb(next);
}

export function getPocketStatus(): PocketLoadStatus {
  return status;
}

export function onPocketStatus(
  cb: (s: PocketLoadStatus) => void,
): () => void {
  listeners.add(cb);
  cb(status);
  return () => listeners.delete(cb);
}

export async function preloadPocket(opts?: {
  voiceCloning?: boolean;
}): Promise<void> {
  await getPocket(opts?.voiceCloning === true);
}

async function getPocket(needCloning: boolean): Promise<PocketInstance> {
  if (instance && (!needCloning || instanceHasCloning)) {
    return instance;
  }
  // Rebuild if we only loaded builtins but now need the encoder
  if (instance && needCloning && !instanceHasCloning) {
    instance.destroy();
    instance = null;
    loadPromise = null;
    preparedRefs.clear();
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    setStatus({
      state: "loading",
      message: needCloning
        ? "Loading Pocket TTS (with voice cloning)…"
        : "Loading Pocket TTS…",
      progress: 0,
    });

    const { PocketTTS } = await import("pocket-tts-js");

    const tts = new PocketTTS({
      language: "english_2026-04",
      quantized: true,
      voiceCloning: needCloning,
      cache: true,
    });

    await tts.load((info) => {
      const prog =
        info.total && info.loaded != null
          ? (info.loaded / info.total) * 100
          : undefined;
      const label =
        info.label ||
        info.status ||
        (info.fromCache ? "Loading from cache…" : "Downloading model…");
      setStatus({
        state: "loading",
        message: label,
        progress: prog,
      });
    });

    const wrapped: PocketInstance = {
      sampleRate: tts.sampleRate,
      predefinedVoices: [...tts.predefinedVoices],
      loadVoice: (name) => tts.loadVoice(name),
      cloneVoice: (audio, opts) => tts.cloneVoice(audio, opts),
      generate: (text, opts) => tts.generate(text, opts),
      stop: () => tts.stop(),
      destroy: () => tts.destroy(),
    };

    instance = wrapped;
    instanceHasCloning = needCloning;
    setStatus({ state: "ready", cloning: needCloning });
    return wrapped;
  })().catch((err) => {
    loadPromise = null;
    const message = err instanceof Error ? err.message : String(err);
    setStatus({ state: "error", message });
    throw err;
  });

  return loadPromise;
}

export function listPocketBuiltinVoices(): { id: string; label: string }[] {
  if (instance?.predefinedVoices.length) {
    return instance.predefinedVoices.map((id) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
    }));
  }
  return POCKET_FALLBACK_VOICES;
}

/** Decode a Blob/File to mono Float32 PCM. */
export async function decodeAudioToMono(
  blob: Blob,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const ctx = new AudioContext();
  try {
    const buf = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const rate = decoded.sampleRate;
    let pcm: Float32Array;
    if (decoded.numberOfChannels === 1) {
      pcm = decoded.getChannelData(0).slice();
    } else {
      const left = decoded.getChannelData(0);
      const right = decoded.getChannelData(1);
      pcm = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        pcm[i] = ((left[i] ?? 0) + (right[i] ?? 0)) / 2;
      }
    }
    // Cap 10 s (model expectation)
    const max = rate * 10;
    if (pcm.length > max) pcm = pcm.slice(0, max);
    return { pcm, sampleRate: rate };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Encode a reference clip, persist PCM to IndexedDB, prepare worker voice.
 * Returns the clone record id.
 */
export async function createPocketClone(opts: {
  name: string;
  pcm: Float32Array;
  sampleRate: number;
}): Promise<PocketCloneRecord> {
  const tts = await getPocket(true);
  const id = newCloneId();
  const ref = await tts.cloneVoice(opts.pcm, {
    inputSampleRate: opts.sampleRate,
    name: id,
  });
  preparedRefs.set(id, ref);
  const record: PocketCloneRecord = {
    id,
    name: opts.name.trim() || "My voice",
    createdAt: Date.now(),
    sampleRate: opts.sampleRate,
    pcm: opts.pcm.slice(),
  };
  await savePocketClone(record);
  return record;
}

async function resolveVoiceRef(
  tts: PocketInstance,
  opts: {
    outputSource: "builtin" | "cloned";
    builtinVoice: string;
    clonedVoiceId: string;
  },
): Promise<string> {
  if (opts.outputSource === "cloned" && opts.clonedVoiceId) {
    const cached = preparedRefs.get(opts.clonedVoiceId);
    if (cached) return cached;
    const rec = await getPocketClone(opts.clonedVoiceId);
    if (!rec) {
      throw new Error(
        `Cloned voice “${opts.clonedVoiceId}” missing — pick a built-in or re-clone.`,
      );
    }
    // Need encoder for re-clone after reload
    const cloningTts = await getPocket(true);
    const ref = await cloningTts.cloneVoice(rec.pcm, {
      inputSampleRate: rec.sampleRate,
      name: rec.id,
    });
    preparedRefs.set(rec.id, ref);
    return ref;
  }

  const name = opts.builtinVoice || "alba";
  const cacheKey = `builtin:${name}`;
  const cached = preparedRefs.get(cacheKey);
  if (cached) return cached;
  const ref = await tts.loadVoice(name);
  preparedRefs.set(cacheKey, ref);
  return ref;
}

/** Synthesize text to a blob: URL suitable for AEC / HTMLAudioElement. */
export async function synthesizePocketUrl(
  text: string,
  opts: {
    outputSource: "builtin" | "cloned";
    builtinVoice: string;
    clonedVoiceId: string;
  },
): Promise<string> {
  const needClone =
    opts.outputSource === "cloned" && Boolean(opts.clonedVoiceId);
  const tts = await getPocket(needClone);
  const voice = await resolveVoiceRef(tts, opts);
  const chunks: Float32Array[] = [];
  await tts.generate(text, {
    voice,
    onChunk: (audio) => {
      chunks.push(audio.slice());
    },
  });
  const { chunksToWavBlob } = await import("pocket-tts-js");
  const blob = chunksToWavBlob(chunks, tts.sampleRate);
  return URL.createObjectURL(blob);
}

/** Hard-stop in-flight generate (barge-in). */
export async function stopPocketGenerate(): Promise<void> {
  if (!instance) return;
  try {
    await instance.stop();
  } catch {
    // ignore
  }
}

export function float32ToWavBlob(
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
