import type { VadResult } from "./vad.ts";

export interface TurnAdapter {
  /** Feed VAD results; returns true when the user finished a turn. */
  onVad(result: VadResult, t_ms: number): boolean;
  reset(): void;
}

/**
 * Fixed silence-based end-of-utterance (legacy).
 * Prefer AdaptiveSilenceTurnDetector.
 */
export class SilenceTurnDetector implements TurnAdapter {
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private speechStartedAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private committed = false;

  constructor(opts?: { silenceMs?: number; minSpeechMs?: number }) {
    this.silenceMs = opts?.silenceMs ?? 600;
    this.minSpeechMs = opts?.minSpeechMs ?? 250;
  }

  onVad(result: VadResult, t_ms: number): boolean {
    if (result.isSpeech) {
      if (this.speechStartedAt === null) this.speechStartedAt = t_ms;
      this.lastSpeechAt = t_ms;
      this.committed = false;
      return false;
    }

    if (
      this.speechStartedAt !== null &&
      this.lastSpeechAt !== null &&
      !this.committed &&
      t_ms - this.lastSpeechAt >= this.silenceMs &&
      this.lastSpeechAt - this.speechStartedAt >= this.minSpeechMs
    ) {
      this.committed = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.speechStartedAt = null;
    this.lastSpeechAt = null;
    this.committed = false;
  }
}

/**
 * Adaptive silence endpointing (not an LM / semantic model).
 *
 * Longer silence for short/noisy bursts, shorter silence after sustained
 * speech — reduces false EOU on mid-sentence pauses without prosody or
 * projected-remaining-words. Phase B may add LM/partial-transcript scoring.
 *
 * Ownership with ASR_MODE=browser: PCM EOU is advisory only — the session
 * skips ASR/think on commitTurn when clientOwnsAsr; browser STT finals
 * (`text_utterance`) are the sole turn commit. With ASR_MODE=http|mock,
 * this detector gates when Whisper/mock finalize runs.
 *
 * Env: TURN_MODE=adaptive|semantic|silence (semantic is an alias of adaptive).
 */
export class AdaptiveSilenceTurnDetector implements TurnAdapter {
  private readonly minSpeechMs: number;
  private readonly shortSpeechMs: number;
  private readonly longSpeechMs: number;
  private readonly silenceShortUtterMs: number;
  private readonly silenceMidMs: number;
  private readonly silenceLongUtterMs: number;
  private readonly silenceNoiseBurstMs: number;
  private speechStartedAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private committed = false;

  constructor(opts?: {
    minSpeechMs?: number;
    shortSpeechMs?: number;
    longSpeechMs?: number;
    silenceShortUtterMs?: number;
    silenceMidMs?: number;
    silenceLongUtterMs?: number;
    silenceNoiseBurstMs?: number;
  }) {
    this.minSpeechMs = opts?.minSpeechMs ?? 250;
    this.shortSpeechMs = opts?.shortSpeechMs ?? 800;
    this.longSpeechMs = opts?.longSpeechMs ?? 2000;
    this.silenceShortUtterMs = opts?.silenceShortUtterMs ?? 750;
    this.silenceMidMs = opts?.silenceMidMs ?? 550;
    this.silenceLongUtterMs = opts?.silenceLongUtterMs ?? 400;
    this.silenceNoiseBurstMs = opts?.silenceNoiseBurstMs ?? 1100;
  }

  onVad(result: VadResult, t_ms: number): boolean {
    if (result.isSpeech) {
      if (this.speechStartedAt === null) this.speechStartedAt = t_ms;
      this.lastSpeechAt = t_ms;
      this.committed = false;
      return false;
    }

    if (
      this.speechStartedAt === null ||
      this.lastSpeechAt === null ||
      this.committed
    ) {
      return false;
    }

    const speechMs = this.lastSpeechAt - this.speechStartedAt;
    if (speechMs < this.minSpeechMs) return false;

    const needSilence = this.silenceNeededMs(speechMs);
    if (t_ms - this.lastSpeechAt >= needSilence) {
      this.committed = true;
      return true;
    }
    return false;
  }

  /** Exposed for tests / telemetry. */
  silenceNeededMs(speechMs: number): number {
    if (speechMs < this.minSpeechMs + 80) return this.silenceNoiseBurstMs;
    if (speechMs < this.shortSpeechMs) return this.silenceShortUtterMs;
    if (speechMs < this.longSpeechMs) return this.silenceMidMs;
    return this.silenceLongUtterMs;
  }

  reset(): void {
    this.speechStartedAt = null;
    this.lastSpeechAt = null;
    this.committed = false;
  }
}

/** @deprecated Use AdaptiveSilenceTurnDetector — name overclaimed "semantic". */
export const SemanticTurnDetector = AdaptiveSilenceTurnDetector;

export function createTurnDetector(): TurnAdapter {
  const mode = (process.env.TURN_MODE || "adaptive").toLowerCase();
  if (mode === "silence") {
    console.log("[turn] mode=silence (fixed)");
    return new SilenceTurnDetector();
  }
  // semantic kept as alias for adaptive
  console.log(
    "[turn] mode=adaptive-silence (PCM EOU; browser STT owns commit when ASR_MODE=browser)",
  );
  return new AdaptiveSilenceTurnDetector();
}
