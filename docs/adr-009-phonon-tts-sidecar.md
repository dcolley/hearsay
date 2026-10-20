# ADR-009: Phonon TTS Sidecar (Offline OpenAI-Compatible Profile)

**Status:** Accepted
**Date:** 2026-10-20
**Related:** `mastra2/src/mastra/perception/tts.ts`, `mastra2/docker/ptts/compose.yaml`, `ADR-006`, `ADR-003`

## Context

TTS so far has one cloud-ish path (`TTS_MODE=http` → Kokoro/Piper sidecar →
MP3) and browser-side engines behind `TTS_MODE=browser`. Two drivers push a
new profile:

1. **Robotics / intermittent connectivity.** A deployment that roams or
   tunnels through unreliable links must keep speaking with zero network.
   Phonon ([Gradium](https://gradium.ai/phonon), built on Kyutai's Pocket TTS
   lineage — the same family our browser `pocket-tts-js` path already uses)
   runs fully offline after first model download, and the 31m checkpoint is
   Apache 2.0.
2. **MP3 chunks cannot derive playback duration.** `ttsChunkDurationMs`
   returns null for MP3, so the echo window (ADR-006) falls back to the
   static `LISTEN_ARM_MS` for every HTTP engine. Phonon's server also serves
   headerless int16 PCM, whose duration is byte-derivable — the same echo
   quality the in-browser blob engines get.

The `HttpTtsAdapter` already speaks OpenAI's `POST /v1/audio/speech`, which
is exactly what `ptts-openai-server` exposes. The seam this feature hangs off
is `createTtsAdapter()` — the same insertion point Kokoro/Piper use; session
and speak-FIFO code need no changes.

## Decision

1. **Deployment shape: Docker container, not a Node service.**
   `ghcr.io/gradium-ai/ptts-openai-server` (CPU, amd64/arm64) binds
   `127.0.0.1:8880`, is managed by its own restart policy, and keeps its
   model/voice cache on a named volume. Adding another Node process would
   duplicate what `HttpTtsAdapter` already does for free.
2. **Checkpoint pinned by SHA:** `PTTS_MODEL=hf://gradium/phonon-31m-en@52433c46…`
   so the cache volume cannot silently drift to repo `main`.
3. **`TTS_FORMAT=pcm`** (new env knob, default `mp3` so existing Kokoro/Piper
   deployments are bit-identical). PCM chunks yield
   `audio/L16; rate=24000; channels=1`, making durations derivable and the
   echo window dynamic.
4. **Warn-once boot probe** (`checkTtsEndpoint`): in `TTS_MODE=http`, one
   `GET /health` after boot; nothing answered → one warning naming the
   compose command. Server never blocks startup or exits.
5. **Voice/condition tuning stays server-side** (`PTTS_VOICE`,
   `PTTS_CONDITION=duration_delta=…`, `PTTS_MAX_CONCURRENT_REQUESTS=1`).
   The model exposes no request-level `speed`, so no client-side rate knob
   is added.

## Explicitly out of scope

- **Voice cloning.** Gradium's clone path is cloud-dependent (Studio/API
  key); the offline rule forbids it. Pocket's client-side clone stays our
  clone story until a local equivalent exists.
- **Multilingual.** 31m is English-only; the 40m models are gated and
  CC BY-NC 4.0. Kokoro remains the multilingual fallback.
- **Browser WASM engine** (`phonon-tts` npm as a presence option) — backlog,
  needs its own latency comparison against pocket-tts-js first.
- **Automatic fallback chains** (http → browser per request) — YAGNI; a dead
  sidecar fails the turn as it does today with Kokoro, plus the boot warning.

## Consequences

- One more container to run, with the same localhost-only hygiene as the
  Spark inference endpoints (the ptts server has no authentication).
- Offline deploys must pre-seed the cache volume on a connected machine;
  `restart: unless-stopped` plus a named volume keeps it across restarts.
- With `TTS_FORMAT=pcm`, HTTP-engine playback now feeds the dynamic echo
  window in ADR-006 instead of the static listen-arm fallback.
- Vendor bet is bounded: anything OpenAI-compatible (Kokoro, Piper) remains
  a drop-in behind the same `TTS_MODE=http` switch.
- Benchmarks so far are vendor-claimed (26–41x realtime, 5–9 ms TTFB).
  Measured evidence on our hardware is tracked below — not yet recorded for
  this deployment (no Docker host available during implementation; the
  integration is verified by unit/integration suite only).

## Verification log

- Unit suite (`tts.test.ts`): pcm/mp3 request shapes, mime→duration
  derivation at 24 kHz, abort-mid-flight, health probe true/false paths.
- End-to-end on a Docker host: compose up, number-heavy sentence (postcodes,
  references) via `response_format=pcm`, measure time-to-first-audio and
  confirm barge echo logs use derived durations (no static-fallback warns).
