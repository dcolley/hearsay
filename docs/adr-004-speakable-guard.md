# ADR-004: Speakable Guard (Local-Model Drift Must Not Reach the Voice)

**Status:** Accepted
**Date:** 2026-10-16
**Related:** `mastra2/src/mastra/perception/speakable.ts`, `reply-text.ts`, `session.ts`

## Context

Hearsay's selling point is **your own** OpenAI-compatible LLM, typically a
local Spark model. Local models under garbled or far-field audio drift into
CJK output — the same failure jarvis-desk-bot documents ("GLM sometimes
answered in Chinese, which an English voice cannot read"). A browser voice
reading CJK produces either silence or garbage; either way the user learns
nothing about what happened.

## Decision

1. **One script filter, always on.** `dropUnreadableScripts` strips CJK
   ideographs, kana, Hangul, CJK punctuation, and fullwidth forms (the exact
   ranges jarvis proved in production) before anything reaches TTS. Applied
   inside `toSpokenReply`, so every spoken path gets it. No env knob — this
   is a floor, not a preference.

2. **Transcript keeps the truth.** The filter touches the audio route only;
   the conversation log and memory see the model's real output.

3. **Honest fallback.** If a turn streamed content but nothing speakable
   survived, the session says "Sorry, I didn't catch that." (metric
   `unreadable_answer_guarded`) instead of going silent.

4. **Guards over phrase-matching.** Consistent with the jarvis lesson
   (they removed reply-text guards entirely and kept model choice + reasoning
   effort) and our own docs stance: exactly one Unicode-script rule, zero
   content heuristics. If output is bad enough that this guard trips often,
   the fix is the model or the audio, not more filters.

## Consequences

- CJK drift costs the user one short apology, never an incomprehensible
  utterance.
- `hasUnreadableScript` gives the log/metrics a "model drifting" signal that
  is actionable: switch model or check input audio, per the latency-table
  lesson.
