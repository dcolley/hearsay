# ADR-002: Laptop Web Perception Path (Browser I/O + Local Node)

**Status:** Accepted  
**Date:** 2026-10-12  
**Updated:** 2026-10-13 (turn-yield cascade)  
**Related:** laptop eyes/ears loop (mastra2 + web)

## Context

For a **laptop** presence surface (mic, speakers, later webcam), we need browser capture with acoustic echo cancellation, noise suppression, and auto gain — which `getUserMedia` provides for free — plus a local agent loop that can later add vision and barge-in.

Streaming mic audio to a cloud STS provider (OpenAI Realtime, Inworld, etc.) would leave the machine and fight the Spark-only brain.

## Decision

For **mastra2 + web on the laptop only**:

1. **Browser** is the I/O layer: `getUserMedia` → WebSocket (PCM + JSON control) → local Node; speakers play TTS chunks returned on the same socket.
2. **Perception** (VAD, turn-yield, turn end, ASR, TTS, vision gates) runs in **local Node** on the Mac (`mastra2` perception WS, default `:4112`).
3. **Cognition** stays on **Spark** via Mastra’s OpenAI provider (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`).
4. Raw PCM/JPEG **do not leave the laptop**. Text (transcripts, scene memory strings) may go to the configured LLM over the local network.

**ADR-001 remains in force for iOS.** This ADR does not authorize server-side audio on the phone path.

### Turn-taking: barge-in is turn-yield, not VAD

**Barge-in is not voice activity detection.** VAD answers “is there speech?”; turn-yield answers “should the agent release the floor?”

**Cascade architecture (locked for laptop web):**

```
Mic + browser AEC → PCM/WS → Silero/energy VAD (presence)
                           → TurnYieldAdapter (while speaking/thinking)
                           → Adaptive silence EOU (listen path)
                ↘ Browser STT (when ASR_MODE=browser) → text_utterance
```

Beamforming / multi-mic delay-compensated models are **out of scope** for browser mono `getUserMedia`.

**Phase A yield signals (implemented):**

1. Voiced frames via Silero (or energy fallback) — not amplitude alone on the client
2. ~300 ms rolling effort (mean Silero prob / energy) before hard yield (`BARGE_EFFORT_MS`)
3. Soft pause on first candidate; hard yield after sustain (`BARGE_IN_SUSTAIN_MS`) **and** effort
4. Echo floor + listen-arm on the **client media clock** (`frame.t_ms`), not mixed `Date.now()`

**Not yet (Phase B+):** prosody (F0 / final lengthening), LM / projected-remaining-words endpointing.

**EOU ownership:**

| `ASR_MODE` | Who commits the user turn |
|------------|---------------------------|
| `browser` | Browser STT finals (`text_utterance`) — PCM adaptive silence is advisory only |
| `http` / `mock` | `AdaptiveSilenceTurnDetector` gates when ASR finalize runs |

`TURN_MODE=adaptive` is adaptive **silence**, not a semantic LM. The `semantic` alias was retired by ADR-005 (it never was semantic).

### Speaker duplex (AEC sink + text echo filter)

Browser AEC only cancels audio treated as a **WebRTC far-end**. Local `HTMLAudioElement` / Web Audio → speakers is invisible to AEC, so TTS on Mac speakers used to self-interrupt via residual mic + browser STT.

**Split synthesis from AEC playback** (engine-agnostic):

| Layer | Responsibility |
|-------|----------------|
| TTS modules | Produce audio + captions (Kokoro, HTTP sidecar, `speechSynthesis`, future engines) |
| AEC playback sink | Play any blob URL / PCM through a local `RTCPeerConnection` loopback so `getUserMedia(echoCancellation)` sees a far-end |
| Spoken-text buffer | Accumulate captions for every engine |
| Echo filter | `isLikelyEcho(stt, spokenTts)` gates client STT barge-in |
| Server yield floor | While waiting for `playback_done`, VAD cannot soft_pause or `hard_yield` (residual would freeze TTS) |

Only engines that expose samples (blob/PCM into the Presence audio queue) get acoustic AEC. `speechSynthesis` cannot feed the sink — it relies on the text echo filter + server floor only. Do **not** special-case a particular TTS engine in the AEC path.

### Failure modes we accept / gate

1. **Half-duplex + residual echo** — Loopback AEC + text filter mitigate speaker bleed; no array mic / residual-echo metric. `BARGE_IN_ENABLED` still defaults **false** until duplex is validated on your hardware (headphones remain the easy path).
2. **Trailing silence before ASR** — Server Whisper path still waits adaptive silence (400–1100 ms) before inference; that fights sub-800 ms RTT. Speculative ASR is Phase B.

### Latency targets

| Metric | Target | How measured |
|--------|--------|----------------|
| Soft→hard yield + client stop | p50 &lt; ~300–350 ms (effort window bound) | `[perception:metrics] hard_yield` + `[presence:metrics] soft_to_playback_stop_ms` |
| Utterance → first TTS chunk | Feel natural &lt; **800 ms**; human-like &lt; **500 ms** (aspirational) | `[perception:metrics] utterance_to_first_tts` `rtt_ms` |

## Consequences

### Positive

- Reuses browser AEC instead of rebuilding it in Node
- Same Spark brain as the dock; perception is swappable adapters
- Clear seam: `VadAdapter` (presence) vs `TurnYieldAdapter` (floor release)

### Negative

- Two local processes (Mastra Studio `:4111` + perception WS `:4112`)
- Requires local ASR/TTS sidecars (or mock/fallback) for a full voice loop
- Laptop path privacy model differs from iOS — document which surface you are testing
- Cascade latency stacks (effort ~300 ms before hard yield)

### Neutral

- Half-duplex first (`HALF_DUPLEX=true`); speaker duplex via AEC sink + text filter when `BARGE_IN_ENABLED=true`

## Implementation

- `mastra2/src/mastra/perception/` — session, bus, `vad.ts`, `turn-yield.ts`, `turn.ts`, WS server (`playbackOpen` blocks VAD hard_yield until `playback_done`)
- `web/src/lib/perception/` + presence UI — capture, `webrtc-aec-playback`, `echo-filter`, playback, WS client (no client RMS hard-barge)
- Env: `OPENAI_*`, `PERCEPTION_WS_PORT`, `ASR_*`, `TTS_*`, `HALF_DUPLEX`, `VAD_MODE`, `BARGE_IN_*`, `BARGE_EFFORT_*`, `LISTEN_ARM_MS`, `TURN_MODE`
- **Memory** (`@mastra/memory` + LibSQL): transcript + observational memory; schema working memory for objects/locations/characteristics. **Not** Workspace.
- **CopilotKit** via `registerCopilotKit` at `/copilotkit` for chat HITL; presence fulfills the same tools over WS `client.action`.
- **HITL `awaiting_user`:** yield must not fire while `ask_user` / `offer_choices` wait; mic/STT stay live for the answer.
)
