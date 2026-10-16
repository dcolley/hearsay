/**
 * Progress speech — the agent talks while it works.
 *
 * While the agent is thinking or running tools, the caller hears silence for
 * seconds and then wonders if it died. This module turns that silence into
 * short spoken updates, modelled on dreamhunter02/jarvis-desk-bot's Hermes
 * provider (see docs/adr-003-progress-updates.md):
 *
 *   "Let me check."            nothing spoken after ``ackAfterMs``
 *   "Searching the web." ...   when a tool starts (once per line; TOOL_LINES)
 *   "Still working on it."     after ``stillAfterMs`` without speech, up to ``maxStill``
 *
 * The narrator is a pure state machine: the caller injects a clock and calls
 * ``tick()`` periodically. It never speaks on its own and never touches TTS.
 *
 * Unlike jarvis-desk-bot, narration here is *outside* the model stream, so the
 * lines never enter conversation memory — no strip-progress step is needed.
 */

export const PROGRESS_ACK = "Let me check.";
export const PROGRESS_STILL = [
  "Still working on it.",
  "Bear with me, almost there.",
  "Still on it.",
];

export type ProgressOptions = {
  /** User utterance this turn answers (request-aware line matching). */
  request: string;
  /** Speak the ack once this much time has passed with no speech. */
  ackAfterMs?: number;
  /** Speak a still-line after this much speechless time. */
  stillAfterMs?: number;
  /** Hard cap on still-lines per turn. */
  maxStill?: number;
  /** false = total silence (same behaviour as before this feature). */
  enabled?: boolean;
};

const DEFAULT_ACK_AFTER_MS = 3_000;
const DEFAULT_STILL_AFTER_MS = 20_000;
const DEFAULT_MAX_STILL = 6;

/**
 * Line per kind of tool (pattern over tool name, then label). First match
 * wins. A `null` line means "stay quiet" — used for tools that speak for
 * themselves (ask_user / offer_choices are HITL: the question IS the update).
 *
 * The request is matched too (lineFor): skill-ish tools have generic names,
 * so "what's the weather" answers with a weather line via the user's words.
 */
const TOOL_PATTERNS: Array<{
  /** matches the tool name */
  tool: RegExp;
  /** matches a human label / argument hint, when given */
  label?: RegExp;
  line: string | null;
}> = [
  { tool: /^(ask_user|offer_choices)$/i, line: null },
  { tool: /web[_-]?search|perplexity|web[_-]?extract/i, line: "Searching the web." },
  { tool: /camera|webcam|frame/i, line: "Checking the camera." },
  { tool: /screenshot|display|screen/i, line: "Having a look at your screen." },
  { tool: /weather/i, line: "Checking the weather." },
  { tool: /date[_-]?time|date|clock/i, line: "Checking the time." },
];

/** Request-aware fallbacks for generic or future tool names. */
const REQUEST_PATTERNS: Array<{ pattern: RegExp; line: string }> = [
  { pattern: /weather|temperature|forecast/i, line: "Checking the weather." },
  { pattern: /\b(search|look up|find out|latest news)\b/i, line: "Searching the web." },
  { pattern: /what time|the date|what'?s the (date|time)|days? until/i, line: "Checking the time." },
  { pattern: /\b(camera|what do you see|webcam)\b/i, line: "Checking the camera." },
  { pattern: /\b(screen|display|desktop)\b/i, line: "Having a look at your screen." },
];

/** Line to speak when a tool starts, or null for silence. */
export function progressLineFor(
  request: string,
  toolName: string,
  label?: string,
): string | null {
  const text = `${request ?? ""} ${toolName ?? ""} ${label ?? ""}`.toLowerCase();
  for (const spec of TOOL_PATTERNS) {
    if (spec.tool.test(toolName) || (spec.label && spec.label.test(text))) {
      return spec.line;
    }
  }
  for (const spec of REQUEST_PATTERNS) {
    if (spec.pattern.test(request ?? "")) return spec.line;
  }
  return null;
}

/** True if a line is narration (metrics/filters; mirrors jarvis PROGRESS_LINES). */
export function isProgressLine(text: string): boolean {
  const t = text.trim().replace(/\.$/, "");
  return (
    t === PROGRESS_ACK.replace(/\.$/, "") ||
    PROGRESS_STILL.some((s) => s.replace(/\.$/, "") === t)
  );
}

/**
 * Every sentence narration can ever speak (ADR-003 narrator + tool-fillers).
 * The memory hygiene guard uses this set to strip exact-sentence echoes from
 * assistant messages before they persist (see narration-guard.ts).
 */
export function narrationSentences(): string[] {
  const lines = new Set<string>([PROGRESS_ACK, ...PROGRESS_STILL]);
  for (const spec of TOOL_PATTERNS) if (spec.line) lines.add(spec.line);
  for (const spec of REQUEST_PATTERNS) lines.add(spec.line);
  return [...lines];
}

export class ProgressNarrator {
  private readonly request: string;
  private readonly ackAfterMs: number;
  private readonly stillAfterMs: number;
  private readonly maxStill: number;
  private readonly enabled: boolean;

  private startedAt: number;
  private lastSpokenAt: number;
  private acked = false;
  private said = new Set<string>();
  private stills = 0;
  /** True while the real answer is streaming; suppresses fillers. */
  private answering = false;

  /** Narration lines spoken this turn (for tests/metrics). */
  readonly spoken: string[] = [];

  constructor(opts: ProgressOptions, private readonly clock: () => number = () => Date.now()) {
    this.request = opts.request ?? "";
    this.ackAfterMs = opts.ackAfterMs ?? DEFAULT_ACK_AFTER_MS;
    this.stillAfterMs = opts.stillAfterMs ?? DEFAULT_STILL_AFTER_MS;
    this.maxStill = opts.maxStill ?? DEFAULT_MAX_STILL;
    this.enabled = opts.enabled ?? true;
    this.startedAt = this.clock();
    this.lastSpokenAt = this.startedAt;
  }

  /**
   * A tool call started. Returns the line to speak, or null (unknown kind,
   * already said, HITL tool, or narration off).
   */
  onToolStart(toolName: string, label?: string): string | null {
    if (!this.enabled) return null;
    // A tool after some text was a preamble; we're working again, not answering.
    this.answering = false;
    const line = progressLineFor(this.request, toolName, label);
    if (!line || this.said.has(line)) return null;
    this.said.add(line);
    this.acked = true;
    this.lastSpokenAt = this.clock();
    this.spoken.push(line);
    return line;
  }

  /** First answer text of the turn is streaming. */
  onAnswerText(): void {
    this.answering = true;
  }

  /**
   * Called periodically by the session. Returns a line to speak, or null.
   * Never repeats the ack, cycles still-lines within maxStill, and goes quiet
   * while the answer itself is streaming.
   */
  tick(): string | null {
    if (!this.enabled || this.answering) return null;
    const now = this.clock();
    if (!this.acked) {
      if (now - this.startedAt >= this.ackAfterMs) {
        this.acked = true;
        this.lastSpokenAt = now;
        this.spoken.push(PROGRESS_ACK);
        return PROGRESS_ACK;
      }
      return null;
    }
    if (this.stills >= this.maxStill) return null;
    if (now - this.lastSpokenAt >= this.stillAfterMs) {
      this.lastSpokenAt = now;
      const line = PROGRESS_STILL[this.stills % PROGRESS_STILL.length];
      this.stills += 1;
      this.spoken.push(line);
      return line;
    }
    return null;
  }
}
