# ADR-006: Dynamic Barge Echo Window and Faded Stop

**Status:** Accepted
**Date:** 2026-10-19
**Related:** `mastra2/src/mastra/perception/session.ts`, `tts.ts`, `turn-yield.ts`, `web/src/lib/perception/fade.ts`, `playback.ts`, `webrtc-aec-playback.ts`

## Context

Two barge-in weaknesses showed up in hardening:

1. **Fixed echo floor guess.** At speak start the session set
   `bargeEchoUntil = now + LISTEN_ARM_MS` (default 700 ms), a static guess
   from speak-start regardless of how long audio was actually issued. For a
   long answer the residual tail is still playing when the floor expires, so
   the room picks up the agent's own voice and false-barges; for a short
   sentence the window overshoots and the user is locked out of interrupting.

2. **Abrupt stop.** Hard-cutting the loopback sink clips the waveform
   mid-cycle (an audible pop) and leaves the last WebRTC-buffered audio
   running through the speakers while the server already considers the floor
   released. Both feed echo and sound broken to the user.

## Decision

1. **Chunk-derived audio end (`audioIssuedEndAt`).** Whenever the session
   issues a TTS chunk whose duration is derivable from its byte count
   (`audioIssuedEndAt` extended by `bytes / 2 / (rate / 1000)`; int16 PCM at
   `PCM_SAMPLE_RATE` 16 kHz, or the `rate=` parameter of an `audio/L16` mime),
   the echo floor at cascade time becomes
   `Math.max(0, audioIssuedEndAt - t_ms) + echoMarginMs`, where
   `echoMarginMs` comes from `BARGE_ECHO_MARGIN_MS` (default 300) and can be
   injected per session via `SessionDeps.echoMarginMs`. When playback truly
   ends (client `playback_done`, barge, session reset, or drain timeout) the
   derived end resets to zero, so the window decays to margin only.
   `LISTEN_ARM_MS` remains the fallback whenever chunk durations are not
   available (mock or text-only TTS), so no existing behavior is regressed.

2. **Fade, not cliff.** Before the hard stop, the browser ramps the loopback
   send gain with `GainNode.gain.linearRampToValueAtTime(0, now + fadeMs)`
   and step-ramps the remote element volume, then performs the existing hard
   cut. The personality mapping (which stop reasons fade and for how long)
   lives in the pure module `web/src/lib/perception/fade.ts`
   (`fadeMsFor` / `fadeForState`), unit-tested without a DOM harness. The
   default `BARGE_FADE_MS` is 150 ms (`NEXT_PUBLIC_BARGE_FADE_MS` in the
   client bundle). Server-side `TtsAdapter.stop()` semantics are unchanged,
   and the wire protocol is untouched: the fade is applied purely client-side
   on the stop signal, which is the smaller diff.

**Explicitly out of scope** for these gaps: the WeSpeaker speaker embedder
(who is talking) and backchannel ignore-lists (uh-huh filtering). Neither is
part of the echo window or the fade, and both belong to separate decisions.

## Consequences

- Long answers are protected for their real residual tail, short ones stop
  locking the user out for a phantom 700 ms.
- Barge-in sounds like a ducked conversation, not a door slam; no mid-cycle
  clip pops.
- `echoFloorAt` (public on the session) is now an observable, testable value
  rather than a private guess, so the cascade tests can assert exact tail
  math with fake chunk clocks.
- Text-only `speechSynthesis` playback still hard-stops (no gain node
  exists); echo protection there continues to rely on the text echo filter
  and listen-arm.
