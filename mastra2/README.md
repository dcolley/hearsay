# Hearsay — server (Mastra Studio + perception)

Mastra Studio on `:4111` (agents + **CopilotKit** `/copilotkit`), perception WebSocket on `:4112`.

See [ADR-002](../docs/adr-002-laptop-web-perception.md).

## Memory vs Workspace

| Use | Primitive |
|-----|-----------|
| Conversation transcript | Mastra **Memory** (message history + observational memory) |
| Camera objects / locations / characteristics | **Working memory** (JSON schema, resource-scoped) |
| Files / shell sandboxes | **Workspace** — not used here |

Shared resource id: `HEARSAY_RESOURCE_ID` (default `hearsay-laptop`) so CopilotKit chat and presence voice share the same world model.

## Env

```bash
cp .env.example .env   # complete defaults for ASR/TTS/VAD/vision
```

| Knob | Default | Notes |
|------|---------|--------|
| `ASR_MODE` | `browser` | Web Speech API in presence; `http` + `ASR_URL` for whisper sidecar; `mock` for loop tests |
| `TTS_MODE` | `browser` | Client speaks `tts_text` via SpeechSynthesis **or** optional in-browser Kokoro (Presence Settings) |
| `TTS_URL` | `http://127.0.0.1:8880` | Sidecar path: set `TTS_MODE=http` + Kokoro FastAPI / Piper → MP3 in the tab |
| `TTS_VOICE` | `af_heart` | Kokoro voice id when using HTTP TTS |
| `VISION_ENABLED` | `true` | Advertised in `hello_ack`; client Start/Stop video |

Agents resolve the model as `{ id: "spark/<name>", url: OPENAI_BASE_URL }` so Mastra uses **Chat Completions** (Spark/vLLM). A bare `openai/...` string would use OpenAI Responses and fail with `item_reference` errors.

### Noise-robust listen / turn-yield (Phase B)

**Barge-in is turn-yield, not VAD.** VAD detects presence; `TurnYieldAdapter` decides when the agent releases the floor. See [ADR-002](../docs/adr-002-laptop-web-perception.md).

| Knob | Default | Role |
|------|---------|------|
| `VAD_MODE` | `silero` | Silero ONNX (`avr-vad`); `energy` = RMS fallback |
| `VAD_ENERGY_THRESHOLD` | `0.02` | Energy fallback gate |
| `BARGE_IN_SUSTAIN_MS` | `180` | Continuous voiced frames before listen-open / yield |
| `BARGE_EFFORT_MS` | `300` | Rolling effort window before hard yield |
| `BARGE_EFFORT_THRESHOLD` | `0.35` | Mean Silero prob / energy over effort window |
| `LISTEN_ARM_MS` | `700` | Deaf window after TTS (client media clock; speaker tail) |
| `BARGE_IN_ENABLED` | `false` | Speaker duplex: WebRTC AEC sink + STT text echo filter (any blob/PCM TTS) |
| `HALF_DUPLEX` | `true` | Mute mic uplink while speaking (unless barge-in on) |
| `TURN_MODE` | `adaptive` | Adaptive silence EOU; `silence` = fixed 600 ms (`semantic` alias) |

**Turn-yield (when enabled):** soft-pause on voiced candidate → hard stop after sustain **and** ~300 ms effort → WS `barge_in`. While client TTS is still playing (`playbackOpen`), VAD yield is ignored entirely (soft residual must not freeze playback). False candidates emit `barge_resume`. Client does **not** hard-barge on RMS energy; STT barge is finals-only and ignores likely TTS echo. Browser STT finals own turn commit when `ASR_MODE=browser`. Latency logs: `[perception:metrics]` / `[presence:metrics]`. Targets: soft→stop ~effort-bound; utterance→first TTS feel &lt;800 ms.

**Speaker duplex:** any blob/PCM TTS through the Presence audio queue gets WebRTC loopback AEC; `speechSynthesis` is text-filter-only for echo. Do not prefer a specific engine “for AEC.”

**Acceptance:** room noise does not start `think()`; ≥350 ms after playback before a new turn; multi-sentence browser TTS plays fully (client `playback_done`); cough soft-pauses then resumes; sustained speech yields the floor; speakers + audio-queue TTS do not self-cut.

```bash
yarn test   # sustain / adaptive EOU / cascade turn-yield fixtures
```

## Run

```bash
yarn install
yarn dev:all            # Studio :4111 + perception :4112
# or:
yarn dev                # Studio + CopilotKit endpoint
yarn perception         # WS only
```

Web (`../web`):

```bash
yarn dev                # http://localhost:3001  (CopilotKit chat)
# Presence: http://localhost:3001/presence
```

Set `NEXT_PUBLIC_COPILOTKIT_URL=http://localhost:4111/copilotkit`.

## Agents & tools

| Agent | Role |
|-------|------|
| `hearsayAgent` / `hearsay-agent` | Spoken + chat assistant (Spark + Memory) |
| `weatherAgent` | Sample (also uses `OPENAI_MODEL`) |

Server tools:

- `get_weather` — Open-Meteo current conditions
- `web_search` — Tavily live web search (`TAVILY_API_KEY`)

Client tools (fulfilled by CopilotKit HITL / presence `client.action`):

- `ask_user` — clarifying question
- `request_camera_frame` — on-demand webcam grab → merges into working memory
- `capture_screenshot` — browser screen/window/tab share → grounded UI description (desktop help)

## Presence notes

The LLM runs only after a **committed turn** (browser STT final, or text Send). Idle/listening with no speech is expected — not a dead model.

Presence **Settings** stores client prefs (WS URL, system TTS voice/rate, auto-start video). Server modes are shown read-only from `hello_ack` (edit `mastra2/.env` and restart perception to change them).

**Better TTS audio:** run an OpenAI-compatible Kokoro (or Piper) server on `TTS_URL`, then set `TTS_MODE=http`. The browser plays returned MP3 via the Presence audio queue (same WebRTC AEC sink as in-browser Kokoro) — no SpeechSynthesis.
