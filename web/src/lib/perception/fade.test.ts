/**
 * Fade policy is pure numbers (ADR-006), no DOM harness needed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BARGE_FADE_MS,
  bargeFadeMsFromEnv,
  fadeForState,
  fadeMsFor,
} from "./fade";

describe("fadeMsFor (barge fade policy)", () => {
  it("fades barge-in and session teardown, never natural drain", () => {
    assert.equal(fadeMsFor("barge_in", 150), 150);
    assert.equal(fadeMsFor("session_end", 150), 150);
    assert.equal(fadeMsFor("soft_release", 150), 0);
    assert.equal(fadeMsFor("turn_end", 150), 0);
  });

  it("honors an overridden barge fade and clamps garbage", () => {
    assert.equal(fadeMsFor("barge_in", 250), 250);
    assert.equal(fadeMsFor("barge_in", 0), 0);
    assert.equal(fadeMsFor("barge_in", -1), 0);
    assert.equal(fadeMsFor("barge_in", Number.NaN), 0);
    assert.equal(fadeMsFor("barge_in", 149.6), 150); // rounds
  });

  it("defaults to 150 ms module constant", () => {
    assert.equal(DEFAULT_BARGE_FADE_MS, 150);
    assert.equal(fadeMsFor("barge_in", DEFAULT_BARGE_FADE_MS), 150);
  });
});

describe("bargeFadeMsFromEnv", () => {
  it("prefers NEXT_PUBLIC_BARGE_FADE_MS, falls back clean", () => {
    assert.equal(bargeFadeMsFromEnv({ NEXT_PUBLIC_BARGE_FADE_MS: "120" }), 120);
    assert.equal(bargeFadeMsFromEnv({ BARGE_FADE_MS: "80" }), 80);
    assert.equal(
      bargeFadeMsFromEnv({
        NEXT_PUBLIC_BARGE_FADE_MS: "20",
        BARGE_FADE_MS: "80",
      }),
      20,
    );
    assert.equal(bargeFadeMsFromEnv({}), DEFAULT_BARGE_FADE_MS);
    assert.equal(bargeFadeMsFromEnv({ BARGE_FADE_MS: "nope" }), DEFAULT_BARGE_FADE_MS);
    assert.equal(bargeFadeMsFromEnv({ BARGE_FADE_MS: "" }), DEFAULT_BARGE_FADE_MS);
  });
});

describe("fadeForState", () => {
  it("fades stops taken while audible, not while idle", () => {
    assert.equal(fadeForState("speaking", 150), 150);
    assert.equal(fadeForState("interrupted", 150), 150);
    assert.equal(fadeForState("listening", 150), 0);
    assert.equal(fadeForState("idle", 150), 0);
    assert.equal(fadeForState("thinking", 150), 0);
  });
});
