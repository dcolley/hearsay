import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orbLook, orbVars, type OrbMood } from "./orb-mood";
import type { AgentState } from "./protocol";

const ALL_STATES: AgentState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "interrupted",
  "awaiting_user",
];

describe("orb mood map", () => {
  it("every agent state maps to a sane look", () => {
    for (const state of ALL_STATES) {
      const look = orbLook(state, true);
      assert.ok(look.mood);
      assert.ok(look.glow >= 0 && look.glow <= 1, `${state} glow`);
      assert.ok(look.size >= 80 && look.size <= 120, `${state} size`);
      assert.ok(look.blinkPeriodMs >= look.blinkDurMs, `${state} blink cadence`);
      assert.ok(look.pulseMs > 0);
      assert.ok(["none", "slow", "track", "sweep"].includes(look.drift));
    }
  });

  it("known states get distinct, meaningful moods", () => {
    assert.equal(orbLook("thinking", true).mood, "ponder");
    assert.equal(orbLook("speaking", true).mood, "talk");
    assert.equal(orbLook("interrupted", true).mood, "startled");
    assert.equal(orbLook("awaiting_user", true).mood, "curious");
    assert.equal(orbLook("listening", true).mood, "alert");
    assert.equal(orbLook("idle", true).mood, "idle");
  });

  it("not running sleeps regardless of reported state", () => {
    const look = orbLook("speaking", false);
    assert.equal(look.mood, "sleep");
    assert.ok(look.glow <= 0.3);
  });

  it("speaking pulses faster than idle (mouth needs a beat)", () => {
    assert.ok(orbLook("speaking", true).pulseMs < orbLook("idle", true).pulseMs);
  });

  it("unknown state falls back to idle", () => {
    assert.equal(orbLook("bogus_state" as AgentState, true).mood, "idle");
  });

  it("orbVars emits CSS custom properties", () => {
    const vars = orbVars(orbLook("idle", true));
    assert.ok(vars["--orb-size"].endsWith("px"));
    assert.ok(vars["--orb-blink-period"].endsWith("ms"));
    assert.ok(vars["--orb-blink-dur"].endsWith("ms"));
    assert.ok(vars["--orb-pulse"].endsWith("ms"));
  });

  it("moods are unique across live states (no two states share a face)", () => {
    const moods = new Set(ALL_STATES.map((s) => orbLook(s, true).mood));
    assert.equal(moods.size, ALL_STATES.length);
    assert.equal<OrbMood | undefined>(undefined, undefined);
  });
});
