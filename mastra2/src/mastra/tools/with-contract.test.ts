import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { ClientBridge } from "../perception/client-bridge.ts";
import { AnnounceQueue } from "../perception/announce-queue.ts";
import { withToolContract } from "./with-contract.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inputSchema = z.object({ n: z.number().optional() });
const outputSchema = z.object({ ok: z.boolean(), value: z.string() });

function slowTool(
  id: string,
  ms: number,
  onExecute?: () => void,
  opts?: { timeoutMs?: number; kind?: "sync" | "hitl" | "async" },
) {
  return withToolContract({
    id,
    description: `contract test stub ${id}`,
    inputSchema,
    outputSchema,
    kind: opts?.kind ?? "sync",
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    execute: async (input: { n?: number }) => {
      onExecute?.();
      await delay(ms);
      return { ok: true, value: `done:${input?.n ?? 0}` };
    },
  });
}

/** tool.execute returns the raw result for these stubs (no validation gotchas). */
async function runTool(
  tool: ReturnType<typeof withToolContract>,
  args: Record<string, unknown>,
  context: Record<string, unknown> = {},
) {
  return (
    tool as unknown as {
      execute: (a: unknown, c: unknown) => Promise<unknown>;
    }
  ).execute(args, { requestContext: new RequestContext(), ...context });
}

describe("tool contracts (ADR-008)", () => {
  it("a stub resolving after the deadline returns a typed timeout and the turn survives", async () => {
    let unhandled = 0;
    const grab = (err: Error) => {
      unhandled++;
      console.error("unhandled rejection:", err);
    };
    process.on("unhandledRejection", grab);
    try {
      const tool = slowTool("late_tool", 300, undefined, { timeoutMs: 30 });
      const result = (await runTool(tool, { n: 1 })) as {
        error?: string;
        tool?: string;
        timeoutMs?: number;
      };
      assert.equal(result.error, "timeout");
      assert.equal(result.tool, "late_tool");
      assert.equal(result.timeoutMs, 30);
      // Let the real work land; the late settle must not reject unhandled.
      await delay(400);
      assert.equal(unhandled, 0, "late tool settle surfaced as unhandled rejection");
    } finally {
      process.off("unhandledRejection", grab);
    }
  });

  it("aborted mid-tool yields a cancelled result and the effect ran exactly once", async () => {
    let effects = 0;
    const tool = slowTool("slow_effect", 300, () => {
      effects++;
    }, { timeoutMs: 5_000 });
    const controller = new AbortController();
    const p = runTool(tool, { n: 2 }, { abortSignal: controller.signal });
    await delay(20);
    controller.abort();
    const result = (await p) as { error?: string; tool?: string };
    assert.equal(result.error, "cancelled");
    assert.equal(result.tool, "slow_effect");
    await delay(350);
    assert.equal(effects, 1, "effect must not be re-executed after cancellation");
  });

  it("uses the env deadline by default and the per-tool timeoutMs override", async () => {
    const prev = process.env.TOOL_TIMEOUT_MS;
    process.env.TOOL_TIMEOUT_MS = "40";
    try {
      const envTool = slowTool("env_tool", 250);
      const viaEnv = (await runTool(envTool, {})) as { error?: string; timeoutMs?: number };
      assert.equal(viaEnv.error, "timeout");
      assert.equal(viaEnv.timeoutMs, 40);

      const overrideTool = slowTool("override_tool", 80, undefined, { timeoutMs: 400 });
      const viaOverride = (await runTool(overrideTool, { n: 3 })) as {
        ok?: boolean;
        value?: string;
      };
      assert.equal(viaOverride.ok, true);
      assert.equal(viaOverride.value, "done:3");
    } finally {
      if (prev === undefined) delete process.env.TOOL_TIMEOUT_MS;
      else process.env.TOOL_TIMEOUT_MS = prev;
    }
  });

  it("HITL tools get no deadline and no cancel binding", async () => {
    const prev = process.env.TOOL_TIMEOUT_MS;
    process.env.TOOL_TIMEOUT_MS = "20";
    try {
      const tool = slowTool("ask_like", 70, undefined, { kind: "hitl", timeoutMs: 15 });
      const controller = new AbortController();
      controller.abort(); // even an already-aborted turn must not cancel HITL
      const result = (await runTool(tool, { n: 4 }, { abortSignal: controller.signal })) as {
        ok?: boolean;
        value?: string;
      };
      assert.equal(result.ok, true);
      assert.equal(result.value, "done:4");
    } finally {
      if (prev === undefined) delete process.env.TOOL_TIMEOUT_MS;
      else process.env.TOOL_TIMEOUT_MS = prev;
    }
  });

  it("client bridge: per-call timeout wins over global, and HITL never times out", async () => {
    const bridge = new ClientBridge({ timeoutMs: 5_000 });
    bridge.setSender(() => {});

    // Per-call timeout is honoured (bridge global would have waited 5 s).
    const t0 = Date.now();
    await assert.rejects(
      bridge.call("capture_screenshot", {}, { timeoutMs: 30 }),
      /timed out/,
    );
    assert.ok(Date.now() - t0 < 2_000, "per-call timeout not applied");

    // ask_user waits indefinitely: pending still true past the global default.
    const bridge2 = new ClientBridge({ timeoutMs: 40 });
    bridge2.setSender(() => {});
    const pending = bridge2.call("ask_user", { question: "which?" });
    let rejected = false;
    pending.catch(() => {
      rejected = true;
    });
    await delay(150);
    assert.equal(rejected, false, "HITL must not get a deadline");
    assert.equal(bridge2.hasPending("ask_user"), true);
    bridge2.resolveAskUserAnswer("this one");
    const answer = (await pending) as { answer?: string };
    assert.equal(answer.answer, "this one");

    // Non-HITL without per-call opts keeps the global default.
    await assert.rejects(bridge2.call("capture_screenshot", {}), /timed out/);
  });

  it("async tools accept immediately and deliver the formatted result to the queue", async () => {
    const queue = new AnnounceQueue({ silenceMs: 1_200, ttlMs: 120_000, max: 3 });
    const tool = withToolContract({
      id: "demo_echo",
      description: "async echo for tests",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      kind: "async",
      formatResult: (out: unknown) => `Echo: ${(out as { text: string }).text}`,
      execute: async (input: { text: string }) => {
        await delay(40);
        return { text: input.text };
      },
    });

    const rc = new RequestContext();
    rc.set("announceQueue", queue);
    const t0 = Date.now();
    const accepted = (await (
      tool as unknown as {
        execute: (a: unknown, c: unknown) => Promise<{ accepted?: boolean; jobId?: string }>;
      }
    ).execute({ text: "hello" }, { requestContext: rc })) as {
      accepted?: boolean;
      jobId?: string;
    };
    assert.equal(accepted.accepted, true);
    assert.ok(accepted.jobId, "jobId required");
    assert.ok(Date.now() - t0 < 30, "accepted must return immediately");

    await delay(200);
    assert.equal(queue.size(), 1);
    assert.equal(queue.peek()?.text, "Echo: hello");

    const modelText = (
      tool as unknown as { toModelOutput: (o: unknown) => { value: string } }
    ).toModelOutput(accepted);
    assert.match(modelText.value, /announced later/i);
  });
});
