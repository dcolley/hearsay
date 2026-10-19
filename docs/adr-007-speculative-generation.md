# ADR-007: Memory-safe speculative generation

## Status

Accepted (the post-review fix round of 2026-10-19 is folded in below; the
invariant - speculative runs never write memory and never have tool effects -
is unchanged)

## Date

2026-10-19

## Related files

- `mastra2/src/mastra/perception/speculation.ts` - the speculation state machine
- `mastra2/src/mastra/perception/server-tool-intent.ts` - server-tool exclusion matcher (weather / web-search phrasing)
- `mastra2/src/mastra/perception/turn.ts` - likely-EOU callback on `AdaptiveSilenceTurnDetector`
- `mastra2/src/mastra/perception/session.ts` - wiring: `onLikelyEou`, `finalizeSpeculative`, `commitSpeculative`, `discardSpeculation`, `emitOrHold`, memory-gate helpers
- `mastra2/src/mastra/memory/hearsay-memory.ts` - the memory write gate (storage domain + `saveMessages`)
- `mastra2/src/mastra/perception/speculation.test.ts`, `mastra2/src/mastra/perception/session.speculation.test.ts`, `mastra2/src/mastra/memory/memory-write-gate.test.ts` - tests
- [ADR-005](./adr-005-smartturn-commit-gate.md) - the commit gate this advances past

## Context

Hearsay waits out adaptive-silence thresholds before finalizing ASR and starting
the LLM, so answer latency is dominated by commit time. LiveKit's realtime
pipeline already does the obvious latency trick: treat "likely end of utterance"
as an early start and generate speculatively, discarding if the user resumes.
We want the same win.

The survey of Mastra-LiveKit found the trap it walks into: Mastra issue
mastra-ai/mastra#22873 - speculative runs persist partial messages into memory
threads. The moment a speculation writes, a discard is no longer free: the
conversation history now contains a question the user never confirmed and an
answer that is being thrown away. LiveKit's own docs describe speculation as
cheap because discards are supposed to be side-effect-free; persistence makes
them not free at all.

A console-trace spike over the installed `@mastra/core` / `@mastra/memory`
proved the bug shape reaches further than the documented `Memory.saveMessages`
hook: the real `agent.stream()` loop persists via `MessageHistory.persistMessages`
straight into the storage memory domain, bypassing the subclass override
entirely. So a gate that only wraps `saveMessages` leaks.

## Decision

1. **Write gate first, generation second.** `HearsayMemory` gains
   `blockWrites(on)`, `flushPending()`, and `clearPending()`. While blocked,
   every message write, whether it arrives through `saveMessages` or through
   the storage-domain shortcut the stream loop uses, is buffered, not stored.
   `flushPending` persists the buffer in original order exactly once;
   `clearPending` drops it, leaving nothing behind. The gate lands as
   `memory-write-gate.test.ts` regression tests before any speculation code
   depends on it.

2. **Likely-EOU advance window.** `AdaptiveSilenceTurnDetector` gains
   `setLikelyEouCallback(cb)`: fired once per utterance when trailing silence
   passes `silenceNeededMs(speechMs) - SPECULATE_ADVANCE_MS` (default 200 ms),
   re-armed by resumed speech, `onVad` return values unchanged.

3. **Speculative run.** At likely-EOU (only when `SPECULATE_MS > 0` and
   `ASR_MODE=http|mock`), the session finalizes ASR on the buffered PCM and
   starts the agent stream in speculative mode: `toolChoice: "none"`, no
   screen/webcam grounding, no `offer_choices` menu, no progress narration,
   and the write gate blocked. Generated sentences go to a HELD buffer, never
   spoken, never `tts_flush`.

4. **Commit promotes, resume discards.** On commit the held buffer is spoken
   through the normal speak FIFO in order, the pending memory writes are
   flushed exactly once, the gate unblocks, and the (possibly still running)
   stream continues into the same FIFO without restarting. On user resume the
   stream is aborted, the held buffer and all timers are dropped, and the
   buffered memory writes are cleared; the turn then goes through the ordinary
   commit path. A speculative stream that nevertheless signals tool intent is
   discarded at the first tool-call chunk.

5. **Off by default.** `SPECULATE_MS=0` (default) leaves the session
   bit-identical to the base tree: no callback wiring, no gate usage, no state
   machine instances.

## Explicitly out of scope

- **`ASR_MODE=browser` partial path.** Browser STT owns turn commit there; the
  session does not hold the PCM buffer to finalize early, so speculation stays
  off (the constructor warns if it is requested).
- **The persistence bug this gate exists to avoid.** We do not attempt to fix
  upstream `MessageHistory` behaviour or race Mastra on #22873. The structural
  invariant is enforced locally at our write choke point instead, so a discard
  cannot leak regardless of which internal path the loop takes.

## Consequences

- Answer latency on confirmed turns drops by roughly the advance window plus
  the ASR finalize overlap, bounded by `SPECULATE_MS` of wasted GPU/LLM work
  per discarded utterance.
- Tool-effect-bearing utterances (weather-style, screenshots, menus) are
  detected before speculation starts, so the only extra cost is generation of
  text that gets thrown away.
- `agent.stream()` options now conditionally carry `toolChoice: "none"`; the
  `offer_choices` path still overrides with `toolChoice: "required"`, which is
  safe because menu utterances are excluded from speculation.
- The write gate is a structural property of `HearsayMemory`, not a convention:
  bypassing it requires going through `super.saveMessages` while blocked,
  which `flushPending` reserves for itself via the `flushing` re-entrancy flag.
- All speculation timers are owned by `SpeculativeTurn` and cleared on every
  terminal transition; the state-machine tests assert handle symmetry, and the
  integration suite runs on real timers without leaks.

## Fix round (2026-10-19, post-review)

### 1. Attempt-ended handoff: a confirmed turn is never lost

The original commit path guarded `if (this.spec !== spec) return;` - but
`discardSpeculation` nulls `this.spec`, so when the attempt ended *during*
`await spec.finalized` (needs-effects / server-tool / empty / asr-error
discard, or budget expiry) the confirmed turn was dropped: STALLED, listening,
nothing spoken or persisted. The rule now is a single handoff - when a
speculation attempt ends, exactly one of two things happens:

1. the attempt committed (promote, `commitSpeculative`, done), or
2. the turn falls through to the ordinary commit path (`commitTurnNormal`)
   exactly once.

The guard branch and the fallthrough are mutually exclusive by construction:
the promote branch returns, and the discard branch is only reached when the
attempt is still ours, so neither can double-commit and neither can stall.
Regression: `session.speculation.test.ts` fires each discard reason during a
commit-await (delayed ASR finalize) and asserts the ordinary commit speaks and
persists exactly one user + assistant pair.

### 2. Server-tool exclusions and a conservative promotion rule

Exclusions were client-tool regexes only (`describe-frame.ts`), so for a
provider that honors `toolChoice: "none"` a weather or web-search question
could promote on a tools-off stream and be answered from model memory with
the tool never executed - a fabricated answer. Two changes:

- **(a) Server-tool gate** [`server-tool-intent.ts`]: `finalizeSpeculative`
  now also discards with reason `server-tool` when the transcript matches
  weather or web-search phrasing (rule set: domain nouns - weather, forecast,
  temperature, degrees, umbrella, humidity, wind speed, news, headlines - and
  verb-frames "will it rain", "is it going to snow", "look ... up", "search
  ... web", "google|googled|googling", "check online", "what's happening".
  Bare condition words without a tool frame ("a haiku about rain") do NOT
  match.) Matched utterances never start a speculative stream; the ordinary
  path (tools available) commits them. Client-tool exclusions
  (needsScreenshot / needsLiveVision / wantsOfferChoices) are kept.
- **(b) Promotion is conservative**: the same stream is continued ONLY when
  the run provably could not have needed tools - after (a) that is exactly
  the set that passes all four exclusion checks (and a stream that emitted a
  tool-call chunk discarded itself). The accepted tool-call-chunk discard
  (`session.ts`, tool-intent) stays as the belt for providers that ignore
  `toolChoice: "none"`.

### 3. Minors

- **Write-gate install before the first stream**: `blockWrites(true)` installs
  the storage-domain wrapper fire-and-forget; `finalizeSpeculative` now awaits
  `ensureWriteGate()` before starting the stream, so file/remote storage
  latency cannot widen the first-persist race.
- **Atomic flush + unblock**: `flushPending()` followed by `blockWrites(false)`
  left a window where a stream write racing the commit was buffered *after*
  the flush and landed late or never. `flushAndUnblock()` keeps the gate
  closed while loop-draining until the buffer is empty, then unblocks with no
  await after the final empty check - so a write racing this commit lands
  in-order at this commit.
- **One retry per utterance, deliberately**: `AdaptiveSilenceTurnDetector.reset()`
  now clears `likelyEouFired`, so the next utterance is guaranteed its
  attempt back through reset() alone (not only via the speech-rearm path).
  Rule stated: one speculation attempt per utterance; an attempt that ends
  early is cheap, because fix 1 hands the turn to the ordinary commit anyway.
