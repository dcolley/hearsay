# Hearsay — web

Next.js + CopilotKit frontend for local Mastra services, plus laptop presence (mic/speakers).

## Setup

```bash
cd web
cp .env.example .env.local   # NEXT_PUBLIC_* defaults
yarn install
yarn dev
```

Open [http://localhost:3001](http://localhost:3001) (chat) or [/presence](http://localhost:3001/presence).

## Backends

| Service | Default URL | Notes |
| --- | --- | --- |
| Mastra 2 + CopilotKit | `http://localhost:4111` | `cd ../mastra2 && yarn dev` — AG-UI at `/copilotkit` |
| Perception WS | `ws://localhost:4112` | `cd ../mastra2 && yarn perception` |
| Hearsay Mastra | `http://localhost:3000` | optional second Mastra if present |

Env (see `.env.example`):

```bash
NEXT_PUBLIC_COPILOTKIT_URL=http://localhost:4111/copilotkit
NEXT_PUBLIC_PERCEPTION_WS_URL=ws://localhost:4112
MASTRA2_URL=http://localhost:4111
```

### Chat (CopilotKit)

Home page talks to `hearsayAgent` over AG-UI. Frontend tools: `ask_user` (HITL), `request_camera_frame` (webcam), `capture_screenshot` (screen/window share).

### Presence (eyes & ears)

1. `mastra2`: `cp .env.example .env`, set `OPENAI_*` → Spark, then `yarn perception` (or `yarn dev:all`).
2. Open `/presence`, headphones on, **Start mic** — or use **Send** for a text turn.
3. **Start video** shows the live camera and streams ~1 fps frames; independent of mic.
4. **Settings** — WS URL, SpeechSynthesis voice/rate, auto-start video; server ASR/TTS/VAD modes are read-only from `hello_ack`.
5. Agent tools arrive as `client.action` (ask / camera / screenshot).
6. **TTS options** (with `TTS_MODE=browser` on the server):
   - **System voice** — SpeechSynthesis (default; no acoustic AEC — text echo filter only)
   - **Kokoro in-browser** — Presence Settings → neural on-device TTS via [`kokoro-js`](https://www.npmjs.com/package/kokoro-js) (same stack as [kokoroweb.app](https://kokoroweb.app/)); first load downloads model weights
   - **Pocket TTS** — built-in Kyutai voices via [`pocket-tts-js`](https://www.npmjs.com/package/pocket-tts-js); optional **Clone a voice…** modal (record/upload → IndexedDB). See root [LEARN.md](../LEARN.md#tts-engines).
   - **HTTP sidecar** — `TTS_MODE=http` + Kokoro FastAPI on `TTS_URL` (browser plays MP3; client Pocket/Kokoro prefs ignored)

   Any blob/PCM audio through the Presence audio queue plays via a WebRTC loopback sink so browser AEC can cancel it on speakers. `speechSynthesis` cannot expose samples — it updates the spoken-text buffer and relies on the STT echo filter. With `BARGE_IN_ENABLED=true`, expect occasional `stt_echo_ignored` logs rather than self-cuts.

## Memory

Conversation + scene working memory live in mastra2 LibSQL (`MEMORY_DB_URL`). Shared `HEARSAY_RESOURCE_ID` across CopilotKit and presence. Workspace is not used for this.
