# ADR-007: Memory-safe speculative generation

## Status

Accepted

## Date

2026-10-19

## Related files

- `mastra2/src/mastra/perception/speculation.ts` - the speculation state machine
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
