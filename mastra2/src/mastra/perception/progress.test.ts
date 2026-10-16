import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProgressNarrator,
  PROGRESS_ACK,
  PROGRESS_STILL,
  isProgressLine,
  progressLineFor,
} from "./progress.ts";

/** Deterministic clock: advance(ms) moves time forward on demand. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function narrator(
  clock: ReturnType<typeof fakeClock>,
  opts?: Partial<ConstructorParameters<typeof ProgressNarrator>[0]>,
) {
  return new ProgressNarrator(
    {
      request: "what's the weather tomorrow?",
      ackAfterMs: 3_000,
      stillAfterMs: 20_000,
      maxStill: 6,
      ...opts,
    },
    clock.now,
  );
}

describe("ProgressNarrator: ack", () => {
  it("stays quiet until ackAfterMs, then says 'Let me check.' once", () => {
    const clock = fakeClock();
    const n = narrator(clock);

    clock.advance(2_999);
    assert.equal(n.tick(), null);

    clock.advance(1);
    assert.equal(n.tick(), PROGRESS_ACK);

    // Never repeats the ack.
    clock.advance(90_000);
    assert.equal(n.tick(), PROGRESS_ACK.replace("Let me check.", PROGRESS_STILL[0]));
    assert.equal(n.tick(), null);
  });

  it("suppression while the answer streams; tool after text reopens narration", () => {
    const clock = fakeClock();
    const n = narrator(clock, { stillAfterMs: 1_000 });

    clock.advance(3_000);
    assert.equal(n.tick(), PROGRESS_ACK);

    n.onAnswerText();
    clock.advance(10_000);
    assert.equal(n.tick(), null, "no fillers while answering");

    // Text before a tool call was a preamble — we're working again.
    assert.equal(n.onToolStart("web_search"), "Searching the web.");
    clock.advance(1_000);
    assert.equal(n.tick(), PROGRESS_STILL[0]);
  });
});

describe("ProgressNarrator: tool lines", () => {
  it("maps tool kinds and never repeats the same line", () => {
    const clock = fakeClock();
    const n = narrator(clock, { request: "check the news please" });

    assert.equal(n.onToolStart("web_search"), "Searching the web.");
    assert.equal(n.onToolStart("web_search"), null, "dedupe per kind");

    assert.equal(n.onToolStart("get_weather"), "Checking the weather.");

    // Tool lines count as speech: no ack needed afterwards.
    clock.advance(10_000);
    assert.equal(n.tick(), null);
  });

  it("HITL tools (ask_user / offer_choices) speak nothing — the question is the update", () => {
    const clock = fakeClock();
    const n = narrator(clock);
    assert.equal(n.onToolStart("ask_user"), null);
    assert.equal(n.onToolStart("offer_choices"), null);
    clock.advance(3_000);
    // HITL lines don't mark speech either, but tick is guarded by the caller
    // (bridge.hasPending); the narrator itself still acks if truly idle.
    assert.equal(n.tick(), PROGRESS_ACK);
  });

  it("falls back to the user request when the tool name is generic", () => {
    const clock = fakeClock();
    const n = narrator(clock, { request: "what time is it in tokyo?" });
    assert.equal(n.onToolStart("run_skill_script"), "Checking the time.");
  });

  it("unknown tool + unrelated request = silence", () => {
    const clock = fakeClock();
    const n = narrator(clock, { request: "tell me a joke" });
    assert.equal(n.onToolStart("mystery_tool"), null);
  });
});

describe("ProgressNarrator: still lines", () => {
  it("fires only after stillAfterMs and cycles within the cap", () => {
    const clock = fakeClock();
    const n = narrator(clock, { stillAfterMs: 1_000, maxStill: 3 });

    clock.advance(3_000);
    assert.equal(n.tick(), PROGRESS_ACK);

    clock.advance(999);
    assert.equal(n.tick(), null);

    clock.advance(1);
    assert.equal(n.tick(), PROGRESS_STILL[0]);
    clock.advance(1_000);
    assert.equal(n.tick(), PROGRESS_STILL[1]);
    clock.advance(1_000);
    assert.equal(n.tick(), PROGRESS_STILL[2]);
    clock.advance(1_000);
    assert.equal(n.tick(), null, "stops at maxStill");
  });
});

describe("ProgressNarrator: disabled", () => {
  it("says nothing at all when enabled=false", () => {
    const clock = fakeClock();
    const n = narrator(clock, { enabled: false });
    clock.advance(3_000);
    assert.equal(n.tick(), null);
    assert.equal(n.onToolStart("web_search"), null);
    clock.advance(30_000);
    assert.equal(n.tick(), null);
    assert.deepEqual(n.spoken, []);
  });
});

describe("progressLineFor / isProgressLine", () => {
  it("maps tools and request fallbacks", () => {
    assert.equal(progressLineFor("look it up", "web_search"), "Searching the web.");
    assert.equal(progressLineFor("look it up", "capture_screenshot"), "Having a look at your screen.");
    assert.equal(progressLineFor("look it up", "request_camera_frame"), "Checking the camera.");
    assert.equal(progressLineFor("what is the forecast", "run_generic"), "Checking the weather.");
    assert.equal(progressLineFor("", "unknown_tool"), null);
  });

  it("recognises narration lines (with or without trailing period)", () => {
    assert.ok(isProgressLine("Let me check."));
    assert.ok(isProgressLine("Still working on it"));
    assert.ok(!isProgressLine("The weather tomorrow is rain."));
  });
});
