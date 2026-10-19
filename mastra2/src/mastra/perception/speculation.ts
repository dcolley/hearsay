/**
 * Speculative generation state machine (ADR-007).
 *
 * idle -> speculative -> committed | discarded.
 *
 * The session owns the actual work (ASR finalize, LLM stream, speak FIFO);
 * this class owns the *state*, the held-spoken-sentence buffer, and the
 * timers. Timers are injected so unit tests run on fake clocks with zero
 * real handles: every transition out of `speculative` clears all timers,
 * which is what keeps the real-timer test suite from leaking.
 *
 * Invariant this machine protects (mastra-ai/mastra#22873): a discarded
 * speculation must leave nothing behind. `discard()` drops the held buffer
 * and the budget timer; the caller additionally aborts the stream and
 * clears the memory-write gate's pending buffer.
 */

export type SpeculationState = "idle" | "speculative" | "committed" | "discarded";

/** Injectable timer surface. Defaults to real timers; tests inject fakes. */
export interface SpeculationTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: SpeculationTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SpeculativeTurnOptions {
  /** Max wall-clock ms a speculation may stay uncommitted before expiring. */
  budgetMs?: number;
  /** Fired when the budget timer expires while still speculative. */
  onBudgetExpired?: () => void;
  timers?: SpeculationTimers;
}

export class SpeculativeTurn {
  private _state: SpeculationState = "idle";
  private _startedAt = 0;
  private budgetTimer: unknown = undefined;
  private readonly budgetMs: number;
  private readonly onBudgetExpired: (() => void) | null;
  private readonly timers: SpeculationTimers;
  /** Sentences produced by the speculative stream, never spoken yet. */
  readonly held: string[] = [];

  constructor(opts?: SpeculativeTurnOptions) {
    this.budgetMs = opts?.budgetMs ?? 0;
    this.onBudgetExpired = opts?.onBudgetExpired ?? null;
    this.timers = opts?.timers ?? realTimers;
  }

  get state(): SpeculationState {
    return this._state;
  }

  get active(): boolean {
    return this._state === "speculative";
  }

  get startedAt(): number {
    return this._startedAt;
  }

  /** Number of live timers. 0 after any terminal transition - test hook. */
  openTimerCount(): number {
    return this.budgetTimer === undefined ? 0 : 1;
  }

  /** idle -> speculative. Starts the budget timer when budgetMs > 0. */
  begin(t_ms?: number): void {
    if (this._state !== "idle") {
      throw new Error(`SpeculativeTurn.begin from ${this._state}`);
    }
    this._state = "speculative";
    this._startedAt = t_ms ?? this.timers.now();
    if (this.budgetMs > 0) {
      const cb = this.onBudgetExpired;
      this.budgetTimer = this.timers.setTimeout(() => {
        this.budgetTimer = undefined;
        cb?.();
      }, this.budgetMs);
    }
  }

  /** Record a speculatively generated sentence for later promotion. */
  hold(sentence: string): void {
    this.held.push(sentence);
  }

  /** Remove all held sentences from the internal buffer. */
  drainHeld(): void {
    this.held.length = 0;
  }

  /** speculative -> committed. Clears timers. False if not speculative. */
  promote(): boolean {
    if (this._state !== "speculative") return false;
    this._state = "committed";
    this.clearTimers();
    return true;
  }

  /**
   * speculative -> discarded. Clears timers AND drops the held buffer, so
   * a discarded run can neither speak nor leak. False if not speculative.
   */
  discard(): boolean {
    if (this._state !== "speculative") return false;
    this._state = "discarded";
    this.clearTimers();
    this.held.length = 0;
    return true;
  }

  /** Back to idle for the next utterance. Always safe. */
  reset(): void {
    this._state = "idle";
    this.clearTimers();
    this.held.length = 0;
    this._startedAt = 0;
  }

  private clearTimers(): void {
    if (this.budgetTimer !== undefined) {
      this.timers.clearTimeout(this.budgetTimer);
      this.budgetTimer = undefined;
    }
  }
}
