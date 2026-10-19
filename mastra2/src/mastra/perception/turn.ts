import type { VadResult } from "./vad.ts";
import type { TurnClassifier } from "./smart-turn.ts";

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
 * Env: TURN_MODE=adaptive|silence. Separately, TURN_GATE=off|smartturn
 * (ADR-005) gates commits on the Smart Turn classifier.
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
  /** Speculative advance window (ADR-007), read once so tests are stable. */
  private readonly speculativeAdvanceMs: number;
  private likelyEouCb: ((t_ms: number) => void) | null = null;
  private likelyEouFired = false;

  constructor(opts?: {
    minSpeechMs?: number;
    shortSpeechMs?: number;
    longSpeechMs?: number;
    silenceShortUtterMs?: number;
    silenceMidMs?: number;
    silenceLongUtterMs?: number;
    silenceNoiseBurstMs?: number;
    speculativeAdvanceMs?: number;
  }) {
    this.minSpeechMs = opts?.minSpeechMs ?? 250;
    this.shortSpeechMs = opts?.shortSpeechMs ?? 800;
    this.longSpeechMs = opts?.longSpeechMs ?? 2000;
    this.silenceShortUtterMs = opts?.silenceShortUtterMs ?? 750;
    this.silenceMidMs = opts?.silenceMidMs ?? 550;
    this.silenceLongUtterMs = opts?.silenceLongUtterMs ?? 400;
    this.silenceNoiseBurstMs = opts?.silenceNoiseBurstMs ?? 1100;
    this.speculativeAdvanceMs =
      opts?.speculativeAdvanceMs ?? Number(process.env.SPECULATE_ADVANCE_MS || 200);
  }

  /**
   * Install a likely-EOU callback (ADR-007 speculation hook). The session
   * wires this only when speculation is enabled (SPECULATE_MS > 0,
   * ASR_MODE http|mock); passing null removes it. The callback fires ONCE
   * per utterance, at `silenceNeededMs(speechMs) - speculativeAdvanceMs`
   * of trailing silence - i.e. shortly before onVad would return true.
   * Resumed speech re-arms it. onVad return values are unchanged.
   */
  setLikelyEouCallback(cb: ((t_ms: number) => void) | null): void {
    this.likelyEouCb = cb;
    this.likelyEouFired = false;
  }

  onVad(result: VadResult, t_ms: number): boolean {
    if (result.isSpeech) {
      if (this.speechStartedAt === null) this.speechStartedAt = t_ms;
      this.lastSpeechAt = t_ms;
      this.committed = false;
      this.likelyEouFired = false;
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
    const silentMs = t_ms - this.lastSpeechAt;

    // ADR-007: fire the early "likely end of utterance" once, inside the
    // advance window but strictly before the real commit threshold.
    if (
      this.likelyEouCb &&
      !this.likelyEouFired &&
      this.speculativeAdvanceMs > 0 &&
      silentMs >= needSilence - this.speculativeAdvanceMs
    ) {
      this.likelyEouFired = true;
      const cb = this.likelyEouCb;
      cb(t_ms);
    }

    if (silentMs >= needSilence) {
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

export type GateState = "armed" | "pending" | "grace" | "commit-next";

/**
 * Silence-only detector + semantic end-of-turn gate (Smart Turn v3).
 *
 * Passes through bit-identically to the base AdaptiveSilenceTurnDetector
 * until the base wants to commit. Then, instead of committing, it asks the
 * classifier on the last-8-second PCM window:
 *
 * - agree (end of turn)          -> commit on the next onVad call
 * - disagree (still in progress) -> base.reset(); commit only allowed after
 *   an extra graceMs of uninterrupted silence, then commit regardless
 *   (bounded; a second disagreement commits immediately - never deadlock)
 * - speech resumes before verdict -> pending inference is cancelled and
 *   state reset (resumed speech proves in-progress)
 * - classifier null / throws     -> gate falls back to silence-only behaviour
 *
 * Inference never blocks onVad. Window timing is frame-driven (t_ms); the
 * session injects the PCM window via setWindowProvider.
 */
export class GatedTurnDetector implements TurnAdapter {
  readonly gateEnabled = true;
  readonly classifierMissing: boolean;
  private base: AdaptiveSilenceTurnDetector;
  private classifier: TurnClassifier | null;
  private readonly graceMs: number;
  private windowProvider: () => Float32Array = () => EMPTY_WINDOW;
  private state: "armed" | "pending" | "grace" | "commit-next" = "armed";
  private generation = 0;
  private disagreeCount = 0;
  private graceFrom: number | null = null;
  private lastT = 0;
  private missingWarned = false;

  constructor(
    base: AdaptiveSilenceTurnDetector,
    classifier: TurnClassifier | null,
    opts?: { graceMs?: number },
  ) {
    this.base = base;
    this.classifier = classifier;
    this.classifierMissing = classifier === null;
    this.graceMs =
      opts?.graceMs ?? Number(process.env.TURN_GATE_GRACE_MS || 600);
  }

  /** Inject the session's utterance window (last 8 s float32). */
  setWindowProvider(fn: () => Float32Array): void {
    this.windowProvider = fn;
  }

  /**
   * Forward the speculation hook (ADR-007) to the wrapped adaptive detector.
   * The likely-EOU callback fires before the gate ever decides to commit;
   * a resumed utterance is discarded by the session's resume check.
   */
  setLikelyEouCallback(cb: ((t_ms: number) => void) | null): void {
    this.base.setLikelyEouCallback(cb);
  }

  onVad(result: VadResult, t_ms: number): boolean {
    this.lastT = t_ms;
    if (!this.classifier) {
      if (!this.missingWarned) {
        this.missingWarned = true;
        console.warn(
          "[turn] smartturn gate requested but model not found - run: yarn models; falling back to adaptive-silence",
        );
      }
      return this.base.onVad(result, t_ms);
    }

    if (this.state === "commit-next") {
      this.state = "armed";
      this.disagreeCount = 0;
      return true;
    }
    const baseSays = this.base.onVad(result, t_ms);

    if (this.state === "pending") {
      if (result.isSpeech) {
        // Resumed speech before the verdict: cancel inference, start over.
        this.generation++;
        this.state = "armed";
        this.base.reset();
      }
      return false;
    }

    if (this.state === "grace") {
      if (baseSays) {
        this.classifierRun();
        return false;
      }
      if (result.isSpeech) {
        this.graceFrom = null;
      } else {
        if (this.graceFrom === null) this.graceFrom = t_ms;
        if (t_ms - this.graceFrom >= this.graceMs) {
          this.state = "armed";
          this.disagreeCount = 0;
          this.graceFrom = null;
          return true;
        }
      }
      return false;
    }

    // armed
    if (baseSays) this.classifierRun();
    return false;
  }

  reset(): void {
    this.base.reset();
    this.generation++;
    this.state = "armed";
    this.disagreeCount = 0;
    this.graceFrom = null;
  }

  /** Exposed for tests / telemetry. */
  debugState(): GateState {
    return this.state;
  }

  private classifierRun(): void {
    const gen = ++this.generation;
    this.state = "pending";
    const pcm = this.windowProvider();
    this.classifier!.isEndOfTurn(pcm).then(
      (verdict) => this.onVerdict(verdict, gen),
      () => this.onVerdict(null, gen),
    );
  }

  private onVerdict(verdict: boolean | null, gen: number): void {
    if (gen !== this.generation || this.state !== "pending") return;
    if (verdict === null) {
      // Classifier unavailable -> fall back to what the base decided: commit.
      this.state = "commit-next";
      return;
    }
    if (verdict) {
      this.state = "commit-next";
      return;
    }
    this.disagreeCount++;
    this.base.reset();
    if (this.disagreeCount >= 2) {
      // Bounded: never deadlock - the second disagreement commits.
      this.state = "commit-next";
      this.disagreeCount = 0;
      return;
    }
    this.state = "grace";
    this.graceFrom = this.lastT; // extra silence counted from the verdict frame
  }
}

const EMPTY_WINDOW = new Float32Array(16_000 * 8);

/**
 * Env: TURN_MODE=adaptive|silence (semantic retired as an alias - it never
 * was semantic). TURN_GATE=off|smartturn (default off) adds the semantic
 * commit gate on top of adaptive silence. TURN_GATE_GRACE_MS overrides the
 * disagree extension (default 600). SMART_TURN_MODEL_PATH / SMART_TURN_THRESHOLD
 * configure the classifier (see scripts/fetch-smart-turn.sh).
 */
let classifierCache: Promise<TurnClassifier | null> | null = null;

async function sharedClassifier(): Promise<TurnClassifier | null> {
  if (!classifierCache) {
    classifierCache = (async () => {
      const { SmartTurnClassifier } = await import("./smart-turn.ts");
      return SmartTurnClassifier.create();
    })();
  }
  return classifierCache;
}

export async function createTurnDetector(): Promise<TurnAdapter> {
  const mode = (process.env.TURN_MODE || "adaptive").toLowerCase();
  if (mode === "silence") {
    console.log("[turn] mode=silence (fixed)");
    return new SilenceTurnDetector();
  }
  const gate = (process.env.TURN_GATE || "off").toLowerCase();
  if (gate !== "smartturn") {
    console.log(
      "[turn] mode=adaptive-silence gate=off (PCM EOU; browser STT owns commit when ASR_MODE=browser)",
    );
    return new AdaptiveSilenceTurnDetector();
  }
  const classifier = await sharedClassifier();
  if (classifier) {
    console.log("[turn] mode=adaptive-silence gate=smartturn classifier=ok");
  } else {
    console.warn(
      "[turn] smartturn gate requested but model not found - run: yarn models; falling back to adaptive-silence",
    );
  }
  return new GatedTurnDetector(new AdaptiveSilenceTurnDetector(), classifier);
}
