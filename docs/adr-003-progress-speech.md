# ADR-003: Progress Speech (The Agent Talks While It Works)

**Status:** Accepted
**Date:** 2026-10-16
**Related:** `mastra2/src/mastra/perception/progress.ts`, `session.ts`, `docs/adr-002-laptop-web-perception.md`

## Context

Hearsay goes silent during tool calls and long model runs. Measured elsewhere
([dreamhunter02/jarvis-desk-bot design notes](https://github.com/dreamhunter02/jarvis-desk-bot/blob/main/docs/design-notes.md)),
a tool-using voice agent can be silent for 20-60 s per turn, and users
conclude it died. Their fix — a provider that speaks short updates from tool
events — worked: first spoken feedback dropped to ~1 s.

Their stack runs narration **inside** the model stream, so spoken fillers
("Let me check.") landed in conversation history and had to be stripped on the
way back. In Hearsay the perception loop owns speech separately from the
model, so we can avoid that problem entirely.

## Decision

1. **Narration lives outside the model stream.** A pure state machine
   (`ProgressNarrator`) is driven by `session.think()`; nothing it says enters
   agent memory, so no strip-progress step exists or is needed.

2. **What gets said:**
   - `"Let me check."` when nothing has been spoken for `PROGRESS_ACK_MS`
     (default 3000) of thinking or tool work.
   - A per-kind line when a `tool-call` chunk starts (`PROGRESS_STILL`
     fallbacks aside; deduped per line per turn): web search → "Searching the
   web.", camera → "Checking the camera.", screenshot → "Having a look at
   your screen.", weather → "Checking the weather.", date/time → "Checking
   the time.".
   - `"Still working on it."` variants after `PROGRESS_STILL_MS` (default
     20000) of speechlessness, capped at `PROGRESS_MAX_STILL` (default 6).
   - Matching is request-aware: skill-ish tools with generic names get their
     line from the **user's own words** (e.g. "what time is it in tokyo?" →
     "Checking the time.").

3. **Silence is a decision, not an absence.** `ask_user` / `offer_choices`
   get no narration (the spoken question *is* the update), and no still-lines
   are emitted while a client tool is waiting (`bridge.hasPending()`).

4. **Narration yields to the answer.** Text-delta streaming marks the turn as
   answering and suppresses fillers; a tool call after text (a preamble)
   reopens narration. Once answering starts, no filler is ever spoken after
   the answer has begun.

5. **One FIFO to the speakers.** Answer sentences and narration fragments are
   queued through a single promise chain (`enqueueSpeak`) so synthesis never
   interleaves; `tts_flush` waits for the queue to drain. Narration therefore
   flows through the same TTS path and respects `playbackOpen`, the echo
   floor, and barge-in exactly like an answer.

6. **Kill switch:** `PROGRESS_ENABLED=false` restores pre-ADR behaviour
   (total silence until the answer). It gates *all* narration, including the
   LiveKit-style tool fillers in `tool-fillers.ts`.

7. **Narration-guard (memory hygiene).** Narration never enters history by
   construction. The guard covers the side doors: `HearsayMemory.saveMessages`
   strips sentences that *exactly match* a known narration line from
   assistant messages before persisting — covering model echo of what was
   heard, or any future in-stream narration. Only whole sentences match (the
   model's own "You are still working on it?" is untouched), only assistant
   messages are filtered, and a pure-echo message is kept intact rather than
   writing an empty hole. Catchphrase fatigue is handled on the narration
   side — still-lines rotate three variants — so the guard never needs to
   guess at read time.

## Consequences

- Long tool runs are never silent; latency telemetry (`utterance_to_first_tts`)
  drops to roughly `PROGRESS_ACK_MS` worst-case.
- The client transcript shows narration lines like tool logs — UI-only, not
  remembered.
- Timers add ~1 line of state to `think()`; the narrator itself is
  dependency-free and unit-tested on a fake clock.

## Measured

Session-level tests (fake agent stream): ack lands on the first tick of the
500 ms poll; still-lines follow `stillAfterMs`; disabled mode speaks only the
answer; `ask_user` wait produces zero fillers. Full suite: 28/28, ~6 s.
