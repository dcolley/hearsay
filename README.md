# Hearsay

**Hearsay is a learning resource** — a working laptop “eyes and ears” stack you can run, break, and steal patterns from.

It is a local voice + vision presence surface: mic and speakers in the browser, webcam and screen capture when needed, turn-taking and barge-in in Node, and an agent that talks to **your** OpenAI-compatible LLM (e.g. Spark). Raw audio and frames stay on the machine; only text (and short vision captions) leave for inference.

> *Hearsay* — what the laptop hears and says. Treat model output as grounded reports, not gospel.

```
Browser (web)  ──WebSocket──►  Perception service (mastra2 :4112)
       ▲                              │
       │ TTS / HITL / screen share    ▼
       └──────── Studio / agents (mastra2 :4111) ──► your LLM
```

**Perception is a separate process** from Mastra Studio. Studio (`yarn dev`, `:4111`) serves agents and CopilotKit. Perception (`yarn perception`, `:4112`) is the long-lived WebSocket service for mic PCM, VAD, turn-yield, TTS, and client tools. Presence will not work if only Studio is running. `yarn dev:all` starts both.

How we built it (decisions + code maps): **[LEARN.md](./LEARN.md)** — especially [two processes](LEARN.md#two-processes-one-product).  
Architecture ADR: [docs/adr-002-laptop-web-perception.md](./docs/adr-002-laptop-web-perception.md).

## Packages

| Path | Role |
|------|------|
| [`mastra2/`](./mastra2) | **Two Node services:** Studio + CopilotKit (`:4111`) and **perception WebSocket** (`:4112`) |
| [`web/`](./web) | Next.js — Presence (`/presence`) and CopilotKit chat |

## Quick start

**Requirements:** Node 20+, Yarn 1.x, an OpenAI-compatible chat API (vision-capable model recommended for camera/screenshot).

You need **three** things running: Studio, **perception**, and the web UI.

```bash
# 1) Backend — Studio AND perception (separate processes)
cd mastra2
cp .env.example .env   # set OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
yarn install
yarn dev:all           # Studio :4111 + perception :4112 together
# Or separately:
#   yarn dev           # Studio only — not enough for Presence
#   yarn perception    # required WebSocket service on :4112

# 2) Frontend (separate terminal)
cd web
cp .env.example .env.local   # or create with the vars below
yarn install
yarn dev               # http://localhost:3001
```

```bash
# web/.env.local
NEXT_PUBLIC_COPILOTKIT_URL=http://localhost:4111/copilotkit
NEXT_PUBLIC_PERCEPTION_WS_URL=ws://localhost:4112
MASTRA2_URL=http://localhost:4111
```

Open **http://localhost:3001/presence** → Start mic. Use headphones first; speakers need barge-in + AEC (see learn topics below).

---

## Learn by building

Use this index as a backlog of features to implement yourself. Each link jumps to **how we did it**, **decisions**, and **code**.

### Core architecture

| Topic | Start here |
|-------|------------|
| Two-process Studio + perception | [LEARN — Two processes](LEARN.md#two-processes-one-product) |
| Browser I/O, Node owns the loop | [LEARN — Browser is I/O](LEARN.md#browser-is-io-node-is-the-loop) |
| Privacy: PCM/JPEG stay local | [LEARN — Browser is I/O](LEARN.md#browser-is-io-node-is-the-loop) |
| Wire protocol (PCM + JSON) | [LEARN — Browser is I/O](LEARN.md#browser-is-io-node-is-the-loop) |

### Voice & turn-taking

| Topic | Start here |
|-------|------------|
| Presence UI (mic / transcript / HITL) | [LEARN — Presence UI](LEARN.md#presence-ui) |
| VAD vs barge-in (turn-yield cascade) | [LEARN — turn-yield](LEARN.md#vad-is-not-barge-in-turn-yield) |
| Soft-pause then hard yield | [LEARN — turn-yield](LEARN.md#vad-is-not-barge-in-turn-yield) |
| End of utterance (browser STT vs Whisper) | [LEARN — End of utterance](LEARN.md#end-of-utterance-listen-path) |
| Streaming TTS by sentence | [LEARN — Streaming spoken replies](LEARN.md#streaming-spoken-replies) |
| Listen-arm after playback | [LEARN — Listen-arm after TTS](LEARN.md#listen-arm-after-tts) |

### Speaker duplex (the hard part)

| Topic | Start here |
|-------|------------|
| Why speakers self-interrupt | [LEARN — Why speakers break](LEARN.md#why-speakers-break-naive-barge-in) |
| WebRTC loopback AEC sink (TTS-agnostic) | [LEARN — AEC sink](LEARN.md#engine-agnostic-aec-sink) |
| Spoken-text echo filter on STT | [LEARN — Text echo filter](LEARN.md#text-echo-filter) |
| Block VAD yield while TTS still playing | [LEARN — Server playback floor](LEARN.md#server-playback-floor) |
| `playback_done` waits for real playout | [LEARN — Wait for real completion](LEARN.md#wait-for-real-playback-completion) |
| Hard barge must silence remote audio | [LEARN — AEC sink](LEARN.md#engine-agnostic-aec-sink) |

### Vision & desktop help

| Topic | Start here |
|-------|------------|
| Webcam capture + multimodal describe | [LEARN — Webcam tool](LEARN.md#webcam-tool) |
| Screen / window / tab screenshot | [LEARN — Screenshot tool](LEARN.md#screenshot-tool-desktop-help) |
| Route “look at the screen” ≠ webcam | [LEARN — Screen vs camera](LEARN.md#screen-vs-camera-routing) |
| Scene working memory | [LEARN — Memory](LEARN.md#memory) |

### Agent tools & HITL

| Topic | Start here |
|-------|------------|
| Client tool bridge (`client.action`) | [LEARN — Client tools](LEARN.md#client-tools-browser-to-agent) |
| `ask_user` / `offer_choices` | [LEARN — Client tools](LEARN.md#client-tools-browser-to-agent) |
| Date / time tools | [LEARN — Date / time](LEARN.md#date--time) |
| Weather & web search | [LEARN — Weather & web search](LEARN.md#weather--web-search) |
| Mastra skills + agent instructions | [LEARN — Agent, skills](LEARN.md#agent-skills-and-server-tools) |

### TTS engines

| Topic | Start here |
|-------|------------|
| System voice vs Kokoro vs HTTP sidecar | [LEARN — TTS engines](LEARN.md#tts-engines) |
| Only blob/PCM engines get acoustic AEC | [LEARN — AEC sink](LEARN.md#engine-agnostic-aec-sink) |

### Stretch goals (not implemented)

| Topic | Why it’s interesting |
|-------|----------------------|
| Single-port Studio + perception | Ops simplicity — [notes](LEARN.md#what-we-consciously-did-not-build) |
| Software AEC3 / residual metrics | Harder than loopback AEC |
| Prosody / LM endpointing | Better EOU than silence alone |
| Speculative ASR | Lower utterance→reply latency |
| Continuous screen share | Observe without re-picking a window |
| Click/type desktop control | Screenshot is observe-only today |

Suggested reading order: [LEARN — Suggested reading order](LEARN.md#suggested-reading-order).

---

## Agent tools (runtime)

- **HITL:** `ask_user`, `offer_choices`
- **Webcam:** `request_camera_frame`
- **Screen:** `capture_screenshot`
- **Clock:** `get_date_time`, `format_date_time`
- **Weather / search:** `get_weather`, `web_search` (needs `TAVILY_API_KEY`)

## Env

See [`mastra2/.env.example`](./mastra2/.env.example). Important knobs:

| Variable | Role |
|----------|------|
| `OPENAI_*` | LLM endpoint |
| `PERCEPTION_WS_PORT` | default `4112` |
| `BARGE_IN_ENABLED` | speaker duplex (AEC + echo filter) |
| `LISTEN_ARM_MS` | post-TTS deaf window |
| `HEARSAY_RESOURCE_ID` | shared memory across chat + presence |
| `HEARSAY_TIMEZONE` | default for date/time tools |
| `TAVILY_API_KEY` | web search |

## License

Add a `LICENSE` if you redistribute. No secrets belong in this repo — keep real `.env` local.
