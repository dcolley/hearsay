import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnnounceQueue } from "./announce-queue.ts";

/**
 * Unit tests run on a fake clock: every gate call passes t_ms explicitly,
 * so no timers are involved.
 */
function queue(opts?: {
  silenceMs?: number;
  ttlMs?: number;
  max?: number;
  hasHitl?: () => boolean;
}) {
  return new AnnounceQueue({
    silenceMs: opts?.silenceMs ?? 1200,
    ttlMs: opts?.ttlMs ?? 120_000,
    max: opts?.max ?? 3,
    hasPendingHitl: opts?.hasHitl,
  });
}

describe("AnnounceQueue (ADR-008)", () => {
  it("does not drain at 1199 ms of silence, drains at 1200 ms", () => {
    const q = queue();
    q.push({ id: "a", tool: "demo", text: "Alpha result" }, 0);
    assert.equal(q.maybeDrain(0, true, false), null, "streak has just begun");
    assert.equal(q.maybeDrain(1199, true, false), null, "1199 ms is not enough");
    const m = q.maybeDrain(1200, true, false);
    assert.equal(m?.text, "Alpha result");
    assert.equal(q.size(), 0);
  });

  it("caps the queue at 3 and evicts the oldest", () => {
    const q = queue();
    q.push({ id: "1", text: "one" }, 0);
    q.push({ id: "2", text: "two" }, 0);
    q.push({ id: "3", text: "three" }, 1);
    const evicted = q.push({ id: "4", text: "four" }, 2);
    assert.equal(evicted?.id, "1");
    assert.equal(q.size(), 3);
    assert.equal(q.maybeDrain(2, true, false), null); // streak starts
    const drained: string[] = [];
    for (;;) {
      const m = q.maybeDrain(1202, true, false);
      if (!m) break;
      drained.push(m.id);
    }
    assert.deepEqual(drained, ["2", "3", "4"]);
  });

  it("drops results older than the TTL", () => {
    // Small numbers to keep the fake clock readable; semantics are linear.
    const q = queue({ ttlMs: 100, silenceMs: 50 });
    q.push({ id: "live", text: "still news" }, 0);
    assert.equal(q.maybeDrain(0, true, false), null);
    // Exactly within TTL (and past the silence gate): drainable.
    assert.equal(q.maybeDrain(99, true, false)?.id, "live");
    // Past TTL: dropped on sight, never drained.
    q.push({ id: "stale", text: "ancient news" }, 20);
    assert.equal(q.maybeDrain(121, true, false), null);
    assert.equal(q.size(), 0);
  });

  it("speaking blocks the drain and restarts the silent streak", () => {
    const q = queue();
    q.push({ id: "s", text: "later" }, 0);
    assert.equal(q.maybeDrain(500, true, false), null);
    assert.equal(q.maybeDrain(2000, true, true), null, "speaking must block");
    // Streak restarts on the first quiet tick after speaking.
    assert.equal(q.maybeDrain(3199, true, false), null, "streak restarted at 3199");
    assert.equal(q.maybeDrain(4398, true, false), null);
    assert.equal(q.maybeDrain(4399, true, false)?.id, "s");
  });

  it("a pending HITL prompt blocks the drain until answered", () => {
    let hitl = true;
    const q = queue({ hasHitl: () => hitl });
    q.push({ id: "h", text: "async result" }, 0);
    assert.equal(q.maybeDrain(500, true, false), null);
    assert.equal(q.maybeDrain(2000, true, false), null, "HITL holds the queue");
    hitl = false;
    // The silent streak was preserved, so it drains on the next tick.
    assert.equal(q.maybeDrain(2100, true, false)?.id, "h");
  });

  it("resume of speech resets the streak; non-silent ticks never drain", () => {
    const q = queue();
    q.push({ id: "r", text: "quiet result" }, 0);
    assert.equal(q.maybeDrain(100, true, false), null);
    assert.equal(q.maybeDrain(600, false, false), null, "speech breaks the streak");
    assert.equal(q.maybeDrain(1200, true, false), null, "streak restarts here");
    assert.equal(q.maybeDrain(2399, true, false), null);
    assert.equal(q.maybeDrain(2400, true, false)?.id, "r");
  });

  it("requeue evicts the OLDEST on overflow, same policy as push", () => {
    // Consistent cap semantics (ADR-008 "the oldest evicts"): the eviction
    // victim past the cap is always the smallest pushedAt, whether the new
    // item arrived via push or via a barge re-queue.
    const q = queue({ max: 3 });
    q.push({ id: "1", text: "one" }, 10);
    q.push({ id: "2", text: "two" }, 11);
    q.push({ id: "3", text: "three" }, 12);
    q.requeue({ id: "late", text: "barged result" }, 20);
    assert.equal(q.size(), 3);
    assert.equal(q.maybeDrain(20, true, false), null, "streak starts");
    const drained: string[] = [];
    for (;;) {
      const m = q.maybeDrain(1220, true, false);
      if (!m) break;
      drained.push(m.id);
    }
    // "1" (oldest) evicted; the re-queued result is NEVER the eviction victim.
    assert.deepEqual(drained, ["late", "2", "3"]);
  });

  it("requeue puts a message back in front, deduped by id", () => {
    const q = queue();
    q.push({ id: "y", text: "second" }, 0);
    q.requeue({ id: "x", text: "first" }, 1);
    q.requeue({ id: "x", text: "first" }, 2); // dedupe: already queued
    assert.equal(q.size(), 2);
    assert.equal(q.maybeDrain(5, true, false), null);
    const first = q.maybeDrain(1205, true, false);
    const second = q.maybeDrain(1205, true, false);
    assert.deepEqual([first?.id, second?.id], ["x", "y"]);
  });
});
