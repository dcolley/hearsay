import { randomUUID } from "node:crypto";

export type ClientActionRequest = {
  id: string;
  tool:
    | "ask_user"
    | "offer_choices"
    | "request_camera_frame"
    | "capture_screenshot";
  args: Record<string, unknown>;
};

export type ClientActionResult = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type Pending = {
  tool: ClientActionRequest["tool"];
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

const WORD_NUMBERS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
] as const;

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
] as const;

/** Match spoken "1" / "two" / "option three" / choice label to offer_choices. */
export function matchChoiceResult(
  spoken: string,
  choices: string[],
): { choice: string; index: number; answer: string } {
  const t = spoken.trim().toLowerCase();
  const asNum = t.match(/\b([1-9])\b/);
  if (asNum) {
    const idx = Number(asNum[1]) - 1;
    if (idx >= 0 && idx < choices.length) {
      const choice = choices[idx]!;
      return { choice, index: idx, answer: choice };
    }
  }
  for (let i = 0; i < choices.length && i < WORD_NUMBERS.length; i++) {
    if (new RegExp(`\\b${WORD_NUMBERS[i]}\\b`).test(t)) {
      const choice = choices[i]!;
      return { choice, index: i, answer: choice };
    }
  }
  for (let i = 0; i < choices.length && i < ORDINALS.length; i++) {
    if (t.includes(ORDINALS[i]!)) {
      const choice = choices[i]!;
      return { choice, index: i, answer: choice };
    }
  }
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i]!;
    if (t.includes(c.toLowerCase()) || c.toLowerCase().includes(t)) {
      return { choice: c, index: i, answer: c };
    }
  }
  return { choice: spoken.trim(), index: -1, answer: spoken.trim() };
}

/**
 * Bridges agent tools to the browser over the perception WebSocket.
 * Tools call `call()`; WS sends `client.action`; client replies with `tool_result`.
 */
export class ClientBridge {
  private pending = new Map<string, Pending>();
  private sendAction: ((req: ClientActionRequest) => void) | null = null;
  private onHitlWait: ((tool: ClientActionRequest["tool"]) => void) | null =
    null;
  private readonly timeoutMs: number;

  constructor(opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 120_000;
  }

  setSender(send: ((req: ClientActionRequest) => void) | null): void {
    this.sendAction = send;
  }

  /** Fired when ask_user / offer_choices is waiting on the client. */
  setHitlWaitHandler(
    fn: ((tool: ClientActionRequest["tool"]) => void) | null,
  ): void {
    this.onHitlWait = fn;
  }

  call(
    tool: ClientActionRequest["tool"],
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    if (!this.sendAction) {
      return Promise.reject(new Error("No client connected for tool bridge"));
    }

    const id = randomUUID();
    const req: ClientActionRequest = { id, tool, args };
    // HITL tools wait for the user and must NOT carry a deadline (ADR-003 /
    // ADR-008); every other client tool uses its per-call/per-tool timeout,
    // falling back to the bridge global default.
    const hitl = tool === "ask_user" || tool === "offer_choices";
    const timeoutMs = hitl ? 0 : (opts?.timeoutMs ?? this.timeoutMs);
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Client tool timed out: ${tool}`));
            }, timeoutMs)
          : undefined;

      this.pending.set(id, { tool, args, resolve, reject, timer });
      this.sendAction!(req);
      if (hitl) {
        this.onHitlWait?.(tool);
      }
    });
  }

  /** True while a client HITL/tool call is waiting (e.g. ask_user). */
  hasPending(tool?: ClientActionRequest["tool"]): boolean {
    if (!tool) return this.pending.size > 0;
    for (const p of this.pending.values()) {
      if (p.tool === tool) return true;
    }
    return false;
  }

  resolveResult(msg: ClientActionResult): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result ?? {});
    else pending.reject(new Error(msg.error || "Client tool failed"));
  }

  /**
   * Resolve the oldest pending ask_user / offer_choices with a spoken/typed answer.
   * Returns true if a pending prompt was fulfilled.
   */
  resolveAskUserAnswer(answer: string): boolean {
    for (const [id, pending] of this.pending) {
      if (pending.tool === "ask_user") {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve({ answer });
        return true;
      }
      if (pending.tool === "offer_choices") {
        const choices = Array.isArray(pending.args.choices)
          ? pending.args.choices.map((c) => String(c))
          : [];
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(matchChoiceResult(answer, choices));
        return true;
      }
    }
    return false;
  }

  clear(): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("Client bridge cleared"));
    }
    this.pending.clear();
    this.sendAction = null;
  }
}

export type ClientBridgeHandle = {
  call: (
    tool: ClientActionRequest["tool"],
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;
};
