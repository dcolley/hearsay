import type { VadResult } from "./vad.ts";
import { SustainedSpeechGate } from "./vad.ts";

/**
 * Turn-yield is not VAD.
 * VAD answers "is there speech?"; yield answers "should the agent release the floor?"
 */

export type TurnYieldAction = "none" | "soft_candidate" | "hard_yield" | "clear";

export type TurnYieldContext = {
  t_ms: number;
  vad: VadResult;
  /** Agent is actively synthesizing / playing TTS. */
  ttsActive: boolean;
  /** Ignore candidates until this client t_ms (echo floor). */
  echoUntil_ms: number;
  agentState: "speaking" | "thinking" | "interrupted";
};

export interface TurnYieldAdapter {
  /** Feed one frame while the agent holds the floor. */
  feed(ctx: TurnYieldContext): TurnYieldAction;
  reset(): void;
}

/**
 * Rolling mean of VAD energy / Silero probability over ~effortMs (default 300).
 * Separates a real attempt to speak from a mic thump or brief cough.
 */
export class EffortWindow {
  private readonly capacity: number;
  private readonly buf: number[];
  private sum = 0;

  constructor(effortMs = Number(process.env.BARGE_EFFORT_MS || 300)) {
    // 20 ms frames
    this.capacity = Math.max(1, Math.ceil(effortMs / 20));
    this.buf = [];
  }

  /** Push one frame score (RMS or speech probability). Returns window mean. */
  push(score: number): number {
    this.buf.push(score);
    this.sum += score;
    if (this.buf.length > this.capacity) {
      this.sum -= this.buf.shift()!;
    }
    return this.mean();
  }

  mean(): number {
    if (this.buf.length === 0) return 0;
    return this.sum / this.buf.length;
  }

  /** True once the window is full and mean ≥ threshold. */
  met(threshold: number): boolean {
    return this.buf.length >= this.capacity && this.mean() >= threshold;
  }

  reset(): void {
    this.buf.length = 0;
    this.sum = 0;
  }

  get size(): number {
    return this.buf.length;
  }

  get full(): boolean {
    return this.buf.length >= this.capacity;
  }
}

/**
 * Cascade turn-yield (Phase A):
 * 1. Soft candidate on voiced frames after echo floor
 * 2. Hard yield only after voiced sustain AND effort window met
 * 3. Clear soft candidate when speech drops before hard yield
 */
export class CascadeTurnYield implements TurnYieldAdapter {
  private readonly sustain: SustainedSpeechGate;
  private readonly effort: EffortWindow;
  private readonly effortThreshold: number;
  private softActive = false;

  constructor(opts?: {
    sustainMs?: number;
    effortMs?: number;
    /** Mean Silero prob / normalized energy required over the effort window. */
    effortThreshold?: number;
  }) {
    const sustainMs =
      opts?.sustainMs ?? Number(process.env.BARGE_IN_SUSTAIN_MS || 180);
    const effortMs =
      opts?.effortMs ?? Number(process.env.BARGE_EFFORT_MS || 300);
    this.sustain = new SustainedSpeechGate(sustainMs);
    this.effort = new EffortWindow(effortMs);
    // Silero probs are ~0–1; energy RMS is typically much lower — use a
    // moderate default that works for Silero; energy mode may need tuning.
    this.effortThreshold =
      opts?.effortThreshold ??
      Number(process.env.BARGE_EFFORT_THRESHOLD || 0.35);
  }

  feed(ctx: TurnYieldContext): TurnYieldAction {
    if (ctx.ttsActive && ctx.t_ms < ctx.echoUntil_ms) {
      this.sustain.reset();
      this.effort.reset();
      if (this.softActive) {
        this.softActive = false;
        return "clear";
      }
      return "none";
    }

    const { vad } = ctx;
    if (vad.isSpeech) {
      this.effort.push(vad.energy);
      const sustainMet = this.sustain.feed(true);
      const effortMet = this.effort.met(this.effortThreshold);

      if (!this.softActive) {
        this.softActive = true;
        // Soft pause immediately; hard wait for sustain+effort
        if (sustainMet && effortMet) {
          this.softActive = false;
          this.sustain.reset();
          this.effort.reset();
          return "hard_yield";
        }
        return "soft_candidate";
      }

      if (sustainMet && effortMet) {
        this.softActive = false;
        this.sustain.reset();
        this.effort.reset();
        return "hard_yield";
      }
      return "none";
    }

    this.sustain.feed(false);
    this.effort.reset();
    if (this.softActive) {
      this.softActive = false;
      return "clear";
    }
    return "none";
  }

  reset(): void {
    this.sustain.reset();
    this.effort.reset();
    this.softActive = false;
  }
}

export function createTurnYieldAdapter(opts?: {
  sustainMs?: number;
}): TurnYieldAdapter {
  console.log(
    `[turn-yield] cascade sustain=${opts?.sustainMs ?? (process.env.BARGE_IN_SUSTAIN_MS || 180)}ms effort=${process.env.BARGE_EFFORT_MS || 300}ms`,
  );
  return new CascadeTurnYield(opts);
}
