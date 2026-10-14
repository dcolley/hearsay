# Hearsay

Local **eyes and ears** for a laptop: voice presence, webcam, and screen capture, with cognition on your own LLM (Spark / any OpenAI-compatible API).

What you hear and see stays on the machine — transcripts and short scene descriptions may go to the model. Raw mic PCM and JPEGs do not leave the laptop.

```
Browser (web)  ──WebSocket──►  Perception (mastra2 :4112)
       ▲                              │
       │ TTS / HITL / screen share    ▼
       └──────── Studio / agents (mastra2 :4111) ──► Spark
```

## Packages

| Path | Role |
|------|------|
| [`mastra2/`](./mastra2) | Mastra Studio (`:4111`), CopilotKit, perception WebSocket (`:4112`), agent + tools |
| [`web/`](./web) | Next.js UI — Presence (`/presence`) and CopilotKit chat |

Architecture notes: [docs/adr-002-laptop-web-perception.md](./docs/adr-002-laptop-web-perception.md).

## Quick start

**Requirements:** Node 20+, Yarn 1.x, an OpenAI-compatible chat API (vision-capable model recommended for camera/screenshot).

```bash
# 1) Agent + perception
cd mastra2
cp .env.example .env   # set OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
yarn install
yarn dev:all           # Studio :4111 + perception :4112

# 2) Frontend (separate terminal)
cd web
cp .env.example .env.local 2>/dev/null || true
# MASTRA2_URL=http://localhost:4111
yarn install
yarn dev               # http://localhost:3001
```

Open **http://localhost:3001/presence**, set perception WS to `ws://localhost:4112`, start the mic.

Optional: `TTS_MODE=browser` with Kokoro or system voice in Presence settings; `ASR_MODE=browser` uses Web Speech in the tab.

## Agent tools

- **Voice / HITL:** `ask_user`, `offer_choices`
- **Webcam:** `request_camera_frame`
- **Screen:** `capture_screenshot` (browser share picker)
- **Clock:** `get_date_time`, `format_date_time`
- **Weather / search:** `get_weather`, `web_search` (Tavily)

## Env (mastra2)

See [`mastra2/.env.example`](./mastra2/.env.example). Important knobs:

- `OPENAI_*` — Spark / LLM
- `PERCEPTION_WS_PORT` — default `4112`
- `BARGE_IN_ENABLED` — speaker duplex (AEC sink + text echo filter)
- `HEARSAY_RESOURCE_ID` — shared memory id across chat + presence
- `HEARSAY_TIMEZONE` — optional default for date/time tools
- `TAVILY_API_KEY` — web search

## License

Private / as published by the author. Add a `LICENSE` file if you open the project.
