/**
 * Tool contracts (ADR-008, gap 3): per-tool deadline + turn-cancellation.
 *
 * Every server tool is created through `withToolContract` instead of raw
 * `createTool`. The contract adds:
 *
 * - a wall-clock deadline (default 15 s, env `TOOL_TIMEOUT_MS`, per-tool
 *   `timeoutMs` config override) - on expiry the model gets a typed
 *   `{ error: "timeout", tool, timeoutMs }` result instead of a crash or a
 *   hung turn, so the agent can apologize gracefully;
 * - turn cancellation: `agent.stream({ abortSignal })` forwards the session's
 *   turn-abort signal into the tool execute context as `context.abortSignal`
 *   (@mastra/core dist `toolOptions`), with `requestContext.turnAbortSignal`
 *   as a fallback for wrappers that build their own context. When the user
 *   barges in mid-tool the execute result resolves
 *   `{ error: "cancelled", tool }` and the effect is never re-run.
 * - `async: true` tools: execute registers the job with the session's
 *   AnnounceQueue and answers `{ accepted: true, jobId }` immediately; the
 *   formatted result lands in the announce queue on completion, never in the
 *   live stream (ADR-008, gap 4).
 *
 * `kind: "hitl"` (`ask_user`, `offer_choices`) deliberately gets NO deadline
 * and NO cancel binding - waiting out a thinking user is the whole point of
 * HITL (ADR-003), so the contract is documentation-only for those tools.
 */
import { createTool } from "@mastra/core/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AnnounceQueue } from "../perception/announce-queue.ts";

export const TOOL_TIMEOUT_MS_DEFAULT = 15_000;

/** env TOOL_TIMEOUT_MS -> effective default deadline. */
export function defaultToolTimeoutMs(): number {
  const n = Number(process.env.TOOL_TIMEOUT_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : TOOL_TIMEOUT_MS_DEFAULT;
}

/** Typed error result shape delivered to the model instead of throwing. */
export const toolContractErrorSchema = z.object({
  error: z.enum(["timeout", "cancelled"]),
  tool: z.string(),
  timeoutMs: z.number().optional(),
});
export type ToolContractError = z.infer<typeof toolContractErrorSchema>;

export function isToolContractError(value: unknown): value is ToolContractError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === "timeout" ||
    (typeof value === "object" &&
      value !== null &&
      (value as { error?: unknown }).error === "cancelled")
  );
}

/** The accepted-immediately envelope an async tool returns. */
export const asyncToolAcceptedSchema = z.object({
  accepted: z.literal(true),
  jobId: z.string(),
});

function contractErrorText(err: ToolContractError): string {
  if (err.error === "timeout") {
    return `Tool ${err.tool} timed out${err.timeoutMs ? ` after ${Math.round(err.timeoutMs / 1000)} seconds` : ""}. The user is waiting - say you could not get that result right now, briefly. Do not call it again this turn.`;
  }
  return `Tool ${err.tool} was cancelled because the user interrupted. Do not call it again this turn.`;
}

/**
 * Read the turn-abort signal from an execute context. Primary:
 * `context.abortSignal` (forwarded by the agent stream loop). Fallback:
 * `requestContext.turnAbortSignal` (set by session.think()).
 */
export function getTurnAbortSignal(context: unknown): AbortSignal | undefined {
  const ctx = context as
    | { abortSignal?: AbortSignal; requestContext?: { get?: (k: string) => unknown } }
    | undefined;
  if (ctx?.abortSignal) return ctx.abortSignal;
  const rc = ctx?.requestContext;
  const sig = typeof rc?.get === "function" ? rc.get("turnAbortSignal") : undefined;
  return sig instanceof AbortSignal ? sig : undefined;
}

/** Effective contract timeout for a tool: per-tool config > env > 15 s. */
export function resolveToolTimeoutMs(configOverride?: number): number {
  if (typeof configOverride === "number" && Number.isFinite(configOverride) && configOverride > 0) {
    return configOverride;
  }
  return defaultToolTimeoutMs();
}

/**
 * Read the deadline injected by the contract wrapper for a bridge call, so
 * client tools get per-call timeouts instead of the bridge's 120 s global.
 */
export function getContractTimeoutMs(requestContext: unknown): number | undefined {
  if (
    requestContext &&
    typeof requestContext === "object" &&
    "get" in requestContext &&
    typeof (requestContext as { get: (k: string) => unknown }).get === "function"
  ) {
    const v = (requestContext as { get: (k: string) => unknown }).get("contractTimeoutMs");
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

export type ContractRunOptions = {
  tool: string;
  /** 0 = no deadline (HITL). */
  timeoutMs: number;
  abortSignal?: AbortSignal;
  work: () => Promise<unknown>;
};

/**
 * The primitive: run `work` under the deadline/abort contract. Resolves with
 * the tool's own value, or a typed error result. A losing race promise gets
 * a no-op catch so a late rejection cannot surface as an unhandled rejection,
 * and nothing is ever re-executed (effects run exactly once).
 */
export async function runWithToolContract<T = unknown>(
  opts: ContractRunOptions,
): Promise<T | ToolContractError> {
  const { tool, timeoutMs } = opts;
  const signal = opts.abortSignal;

  if (signal?.aborted) return { error: "cancelled", tool };

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const work = Promise.resolve().then(opts.work);
  // Late settle after a timeout/abort must not crash the process.
  work.catch(() => {});

  const outcome = await new Promise<T | ToolContractError>((resolve, reject) => {
    const finish = (v: T | ToolContractError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ error: "timeout", tool, timeoutMs }), timeoutMs);
      timer.unref?.();
    }
    if (signal) {
      onAbort = () => finish({ error: "cancelled", tool });
      signal.addEventListener("abort", onAbort, { once: true });
    }
    work.then(
      (v) => finish(v as T),
      (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
  return outcome;
}

export type ContractToolConfig = {
  id: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute: (input: any, context: any) => Promise<unknown>;
  toModelOutput?: (output: any) => { type: "text"; value: string };
  /** Per-tool deadline override (default: TOOL_TIMEOUT_MS env or 15 s). */
  timeoutMs?: number;
  /** "hitl" tools opt out of deadline + cancel entirely. */
  kind?: "sync" | "client" | "hitl" | "async";
  /** For async tools: format the settled result into a single spoken line. */
  formatResult?: (output: unknown) => string;
};

function defaultFormatResult(output: unknown): string {
  if (typeof output === "string") return output;
  if (
    output &&
    typeof output === "object" &&
    "text" in output &&
    typeof (output as { text: unknown }).text === "string"
  ) {
    return (output as { text: string }).text;
  }
  return JSON.stringify(output);
}

/**
 * Create a tool with the ADR-008 contract applied. Returns the same kind of
 * tool object createTool returns, so agents/tests consume it identically.
 */
export function withToolContract(config: ContractToolConfig) {
  const kind = config.kind ?? "sync";
  const timeoutMs = resolveToolTimeoutMs(config.timeoutMs);

  if (kind === "hitl") {
    // Documentation-only contract: HITL waits for the user, by design.
    const tool = createTool({
      id: config.id,
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      execute: config.execute,
      ...(config.toModelOutput ? { toModelOutput: config.toModelOutput } : {}),
    });
    (tool as unknown as { contract: unknown }).contract = { kind, timeoutMs: 0 };
    return tool;
  }

  if (kind === "async") {
    const tool = createTool({
      id: config.id,
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: asyncToolAcceptedSchema,
      execute: async (input: any, context: any) => {
        const queue = (
          context?.requestContext as { get?: (k: string) => unknown } | undefined
        )?.get?.("announceQueue") as AnnounceQueue | undefined;
        const jobId = randomUUID();
        const work = Promise.resolve().then(() => config.execute(input, context));
        work.catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[tool:${config.id}] async job failed:`, message);
        });
        if (queue) {
          work
            .then((output) => {
              queue.push(
                { id: jobId, tool: config.id, text: (config.formatResult ?? defaultFormatResult)(output) },
                Date.now(),
              );
            })
            .catch(() => {
              // the failure is logged above; nothing to announce
            });
        } else {
          console.warn(
            `[tool:${config.id}] async tool has no announceQueue in requestContext; result will be dropped`,
          );
        }
        return { accepted: true as const, jobId };
      },
      toModelOutput: (output: unknown) => {
        if (
          output &&
          typeof output === "object" &&
          "accepted" in output &&
          (output as { accepted?: unknown }).accepted === true
        ) {
          return {
            type: "text" as const,
            value:
              "Job accepted. The result will be announced later when there is silence. Say only that you are working on it.",
          };
        }
        return { type: "text" as const, value: JSON.stringify(output) };
      },
    });
    (tool as unknown as { contract: unknown }).contract = { kind, timeoutMs: 0 };
    return tool;
  }

  // "sync" | "client": deadline + turn-cancel + typed error results.
  const unionSchema = z.union([config.outputSchema, toolContractErrorSchema]);
  const tool = createTool({
    id: config.id,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: unionSchema,
    execute: async (input: any, context: any) => {
      // Inject the effective deadline so client tools can pass it to the
      // bridge as a per-call timeout instead of the bridge global default.
      const rc = context?.requestContext as
        | { set?: (k: string, v: unknown) => void }
        | undefined;
      if (typeof rc?.set === "function" && kind === "client") {
        rc.set("contractTimeoutMs", timeoutMs);
      }
      const abortSignal = getTurnAbortSignal(context);
      const outcome = await runWithToolContract({
        tool: config.id,
        timeoutMs,
        abortSignal,
        work: () => config.execute(input, context),
      });
      return outcome;
    },
    toModelOutput: (output: unknown) => {
      if (isToolContractError(output)) {
        return { type: "text" as const, value: contractErrorText(output) };
      }
      if (config.toModelOutput) return config.toModelOutput(output);
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });
  (tool as unknown as { contract: unknown }).contract = { kind, timeoutMs };
  return tool;
}
