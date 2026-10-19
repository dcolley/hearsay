# ADR-008: Tool contracts and the silence-gated announce queue

## Status

Accepted

## Date

2026-10-19

## Related files

- `mastra2/src/mastra/tools/with-contract.ts` - the contract helper (deadline, turn cancel, async envelope)
- `mastra2/src/mastra/perception/announce-queue.ts` - the deferred-result queue and drain gate
- `mastra2/src/mastra/tools/weather-tool.ts`, `web-search-tool.ts`, `date-time-tool.ts`, `client-tools.ts` - every server tool now goes through `withToolContract`
- `mastra2/src/mastra/perception/client-bridge.ts` - per-call timeouts; HITL calls carry no timer
- `mastra2/src/mastra/perception/session.ts` - wiring: `turnAbortSignal` + `announceQueue` into `requestContext`, VAD-tick + poll drain, barge re-queue
- `mastra2/src/mastra/tools/with-contract.test.ts`, `mastra2/src/mastra/perception/announce-queue.test.ts`, `mastra2/src/mastra/perception/session.announce.test.ts` - tests
- [ADR-003](./adr-003-progress-speech.md) - the HITL silence rule this preserves
- [ADR-007](./adr-007-speculative-generation.md) - the turn abort machinery this reuses

## Context

The survey of the two remaining gaps came down to timing decisions nobody had made explicit.

**Gap 3: tools had neither a deadline nor an interruption response.** A weather
call to Open-Meteo or a Tavily search that hangs can block a spoken turn
forever, and a user who barges in mid-tool leaves the effect running in a turn
the model no longer has. The client bridge was the partial exception: a 120 s
global timer on every call, which is both too slow for a server tool and, in
the other direction, wrong for `ask_user` where waiting is the point.

**Gap 4: an async result had nowhere safe to land.** A job that finishes after
its turn either gets interrupted with the stream or barges over whoever is
talking. Both lose the result or say it to the wrong moment. What is wanted is
the opposite instinct of ADR-003: narration speaks the instant work starts, an
async result speaks the instant the room is quiet.

The cancellation mechanism was verified against the installed
`@mastra/core` (1.76) before this design: the agent stream loop builds the
tool execute context with `abortSignal` included in `toolOptions`, derived via
`AbortSignal.any` from the `abortSignal` option of `agent.stream()`. The
session's `turnAbort` (barge-in, commit gate, speculation discard, the same
controller ADR-007 parks on) therefore reaches every tool execute as
`context.abortSignal`, and session.think() additionally copies it to
`requestContext.turnAbortSignal` for wrappers that build their own context.
No Mastra change is needed.

## Decision

1. **One contract helper, three kinds.** Every server tool is created with
   `withToolContract` instead of raw `createTool`. The helper adds a wall
   clock deadline (`config.timeoutMs` > env `TOOL_TIMEOUT_MS` > 15 s), binds
   cancellation to the turn's abort signal, and converts a breach into a
   typed result rather than a throw:

   ```
   { error: "timeout" | "cancelled", tool, timeoutMs? }
   ```

   The `toModelOutput` wrapper turns that shape into a short apology
   instruction, so the agent apologizes gracefully and the turn continues.
   A losing race promise gets a no-op catch, so a late tool settle cannot
   surface as an unhandled rejection, and nothing is ever re-executed:
   effects run exactly once.

2. **`kind` documents what the contract is allowed to do.** `sync` server
   tools and `client` tools over the bridge cancel with the turn. `hitl`
   tools (`ask_user`, `offer_choices`) deliberately get no deadline and no
   cancel binding: waiting out a thinking user is the feature (ADR-003), and
   the bridge now attaches no timer at all to their calls. `async` tools
   answer `{ accepted: true, jobId }` immediately and resolve into the
   announce queue. As of this writing no production tool registers
   `kind: "async"`: the queue ships wired and tested, with no live
   producer yet.

3. **Client tools get per-call timeouts.** `ClientBridge.call` accepts
   `{ timeoutMs }`, set by the contract wrapper from the tool's effective
   deadline; the 120 s global remains only as a fallback for unmanaged calls.
   `ask_user` / `offer_choices` calls carry no timer.

4. **Announcements are silence-gated, not stream-bound.** `AnnounceQueue`
   (push/drain, injected clock) holds formatted results. A drain returns a
   result only when a silent streak has held for `ANNOUNCE_SILENCE_MS`
   (default 1200), the session is not speaking, and no HITL prompt is
   waiting (`bridge.hasPending()`). Past `ANNOUNCE_TTL_MS` (default 120 s)
   results drop as stale; past 3 queued, the oldest evicts. Silence is room
   state: resumed speech or speech of our own restarts the streak.

5. **Async results survive interruption.** An `async: true` tool's execute
   registers the job and returns the accepted envelope without speaking
   anything itself; the formatted completion lands in the queue, never the
   live stream. The session drains through the ordinary speak FIFO (never a
   concurrent `speakFragment`; `tts_flush` only after the FIFO drains), fed
   by VAD silence ticks, queue push events, and a small poll timer injected
   via `SessionDeps` like the progress ack/still knobs. A barge-in that
   catches the announce itself re-queues the in-flight messages, deduped by
   id, so interruption cannot lose a result.

### Numbers

| knob | default | env | notes |
|------|---------|-----|-------|
| sync tool deadline | 15 s | `TOOL_TIMEOUT_MS` | per-tool `timeoutMs` config overrides |
| camera / screenshot budget | 120 s | config `timeoutMs` | keeps the bridge-era budget, now per-tool |
| bridge global fallback | 120 s | `ClientBridge opts` | only for calls with no contract |
| silence gate | 1200 ms | `ANNOUNCE_SILENCE_MS` | continuous, any speech resets it |
| announce queue cap | 3 | fixed | oldest evicted |
| announce TTL | 120 s | `ANNOUNCE_TTL_MS` | stale results dropped, never spoken |

### Cancel semantics per kind

| kind | deadline | turn cancel | on breach the model receives |
|------|----------|-------------|------------------------------|
| `sync` | 15 s default, configurable | yes, via `context.abortSignal` | `{ error: "timeout" \| "cancelled", tool, timeoutMs }` |
| `client` | per-tool `timeoutMs` (camera/screenshot 120 s), bridge per-call timer mirrors it | yes | same typed shape |
| `async` | none after acceptance | no: the job runs detached and the result survives | `{ accepted: true, jobId }`, result arrives via `AnnounceQueue` |
| `hitl` | none | none | the user's answer |

## Explicitly out of scope

- **Retry policies.** A timed-out tool is apologized for, not retried. A
  retry policy that survives turn boundaries would need an idempotency story
  this repo does not have yet.
- **Tool authentication / permissions.** Tools keep running server-side
  unprivileged, exactly as before this ADR.

## Consequences

- A hung network call is a spoken apology inside 15 s instead of a dead
  session; the suite verifies the turn survives a timeout with no unhandled
  rejection, and that cancellation does not double-record effects.
- Barge-in is now effect-honest: a tool whose turn the user interrupted
  stops being answered into that turn, once.
- Long async results arrive once, at the first genuinely quiet moment, and
  never interrupt a HITL question. Results older than two minutes are
  dropped rather than announced out of context.
- Known limitation: a HITL prompt the user never answers blocks announce
  drains for as long as it stays pending — `bridge.hasPending()` outranks
  async results by design, and no TTL applies to the block itself (the
  queued results do expire on the next drain visit, so nothing lingers
  past `ANNOUNCE_TTL_MS`). The escape hatch is `reset()` or
  `clearConversation()`: both clear the pending HITL calls, and the queue
  drains again.
- `ask_user` / `offer_choices` can no longer die to a bridge timer; HITL
  waits exactly as long as the user takes.
- The announce path reuses the live-turn machinery (speak FIFO,
  `turnAbort`, playback handshake, listen arm) so barge-in, echo floor, and
  `playback_done` behave identically over announced speech.
