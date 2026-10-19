/**
 * Silence-gated deferred announcements (ADR-008, gap 4).
 *
 * Async tool results must survive turn interruption: the result is NOT
 * spoken live and never re-enters the model stream. It lands in this queue,
 * and the session drains it into the speak FIFO only when the room is
 * actually quiet: `ANNOUNCE_SILENCE_MS` of continuous silence (default
 * 1200), not speaking, and no HITL prompt waiting (`bridge.hasPending()`).
 *
 * Pure state with an injected clock (every call takes `t_ms`) - no timers
 * inside. The session owns the drain timers (VAD silence ticks + a small
 * poll, injected via SessionDeps like progress ack/still).
 */

/** One queued announcement. `text` is pre-formatted for TTS. */
export type AnnounceMessage = {
  id: string;
  tool?: string;
  text: string;
  /** Server clock ms when the result landed (for TTL). */
  pushedAt: number;
};

export type AnnounceQueueOptions = {
  /** Continuous silence required before draining. Default ANNOUNCE_SILENCE_MS or 1200. */
  silenceMs?: number;
  /** Result age past which it is dropped as stale. Default ANNOUNCE_TTL_MS or 120000. */
  ttlMs?: number;
  /** Max queued results; oldest is evicted past the cap. Default 3. */
  max?: number;
  /** Called at drain time: true while ask_user / offer_choices waits. */
  hasPendingHitl?: () => boolean;
};

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const ANNOUNCE_SILENCE_MS_DEFAULT = 1200;
export const ANNOUNCE_TTL_MS_DEFAULT = 120_000;
export const ANNOUNCE_MAX_DEFAULT = 3;

/** Tiny sync emitter for `pushed` notifications (session drains promptly). */
type Listener = (msg: AnnounceMessage) => void;

export class AnnounceQueue {
  readonly silenceMs: number;
  readonly ttlMs: number;
  readonly max: number;
  private hasPendingHitl: () => boolean;
  private items: AnnounceMessage[] = [];
  /** Media/server clock ms when the current silent stretch began (null = heard speech recently). */
  private silenceSince: number | null = null;
  private listeners = new Set<Listener>();

  constructor(opts?: AnnounceQueueOptions) {
    this.silenceMs = opts?.silenceMs ?? envNum("ANNOUNCE_SILENCE_MS", ANNOUNCE_SILENCE_MS_DEFAULT);
    this.ttlMs = opts?.ttlMs ?? envNum("ANNOUNCE_TTL_MS", ANNOUNCE_TTL_MS_DEFAULT);
    this.max = opts?.max ?? ANNOUNCE_MAX_DEFAULT;
    this.hasPendingHitl = opts?.hasPendingHitl ?? (() => false);
  }

  /** Subscribe to push events (a new result is worth a prompt drain check). */
  onPushed(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Queue a finished result. Past the cap the OLDEST is evicted. Returns the
   * evicted message (if any) so the session can log/metric it.
   */
  push(msg: { id: string; tool?: string; text: string }, t_ms: number): AnnounceMessage | null {
    const item: AnnounceMessage = {
      id: msg.id,
      tool: msg.tool,
      text: msg.text,
      pushedAt: t_ms,
    };
    this.items.push(item);
    let evicted: AnnounceMessage | null = null;
    while (this.items.length > this.max) {
      evicted = this.evictOldest() ?? evicted;
    }
    for (const fn of this.listeners) {
      try {
        fn(item);
      } catch {
        // drain listeners must never break the tool completion path
      }
    }
    return evicted;
  }

  /**
   * Drain gate check on a silence tick. Returns the oldest live message
   * exactly when:
   *   - `isSilent` has held continuously for >= `silenceMs` (resumed speech
   *     or speaking resets the streak), AND
   *   - not `speaking`, AND
   *   - `hasPendingHitl()` is false.
   * Stale (TTL) entries are dropped on every call. One message per call so
   * the session speaks FIFO-drained, one announcement at a time.
   */
  maybeDrain(t_ms: number, isSilent: boolean, speaking = false): AnnounceMessage | null {
    // TTL sweep regardless of gate state - nothing stale survives a visit.
    this.items = this.items.filter((m) => t_ms - m.pushedAt <= this.ttlMs);

    if (speaking || !isSilent) {
      this.silenceSince = null;
      return null;
    }
    if (this.silenceSince === null) this.silenceSince = t_ms;

    // A waiting HITL question outranks an async result; hold the queue (and
    // the silent streak) until the user answers.
    if (this.hasPendingHitl()) return null;

    if (this.items.length > 0 && t_ms - this.silenceSince >= this.silenceMs) {
      // Silence is the room state, not per-message: every pending result is
      // drainable while the quiet stretch holds. The streak continues.
      const msg = this.items.shift() ?? null;
      return msg;
    }
    return null;
  }

  /**
   * Remove and return the OLDEST queued message (smallest `pushedAt`,
   * position ties broken by queue order). One eviction policy for every
   * overflow path: "past the cap the oldest evicts" (ADR-008 Numbers table),
   * whether the new item arrived via push or via requeue.
   */
  private evictOldest(): AnnounceMessage | null {
    if (this.items.length === 0) return null;
    let oldest = 0;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i]!.pushedAt < this.items[oldest]!.pushedAt) oldest = i;
    }
    return this.items.splice(oldest, 1)[0] ?? null;
  }

  /** Number of live (non-stale as of `t_ms`) messages. */
  size(t_ms?: number): number {
    if (t_ms === undefined) return this.items.length;
    return this.items.filter((m) => t_ms - m.pushedAt <= this.ttlMs).length;
  }

  /** Oldest live message without consuming (tests / metrics). */
  peek(t_ms?: number): AnnounceMessage | null {
    return this.items.length ? this.items[0]! : null;
  }

  clear(): void {
    this.items = [];
    this.silenceSince = null;
  }

  /**
   * Re-queue an in-flight message (barge during the announce itself). It
   * goes to the FRONT so order is preserved, deduped by id so an interrupted
   * result can never be spoken twice. Past the cap the OLDEST evicts — the
   * same policy as `push`, never the freshly re-queued result.
   */
  requeue(msg: { id: string; tool?: string; text: string }, t_ms: number): void {
    if (this.items.some((m) => m.id === msg.id)) return;
    this.items.unshift({ id: msg.id, tool: msg.tool, text: msg.text, pushedAt: t_ms });
    while (this.items.length > this.max) this.evictOldest();
  }
}
