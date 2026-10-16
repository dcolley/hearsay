# LEARN — how Hearsay is built

This document explains **what we built**, **why**, and **where to look in the code**. Use it as a map when implementing similar features in your own stack.

Paths are relative to the repo root. Prefer reading the linked files over copying blindly — several decisions are laptop-browser specific.

---

## Architecture

### Two processes, one product

Hearsay deliberately splits **cognition** (Mastra Studio / agents) from **perception** (real-time mic, VAD, turn-yield, TTS bridge).

| Process | Port | Job |
|---------|------|-----|
| `yarn dev` (Studio) | `:4111` | Agents, CopilotKit, tools, memory |
| `yarn perception` | `:4112` | Long-lived WebSocket: PCM, state, TTS, client tools |

**Decision:** Studio’s HTTP API is a poor fit for continuous PCM + duplex control, so perception is a separate `ws` entrypoint. They can share one port later (HTTP upgrade); today they stay split so you can restart perception without bouncing Studio.

- Studio entry: [`mastra2/src/mastra/index.ts`](mastra2/src/mastra/index.ts)
- Perception entry: [`mastra2/src/mastra/perception/main.ts`](mastra2/src/mastra/perception/main.ts)
- Wire-up ADR: [`docs/adr-002-laptop-web-perception.md`](docs/adr-002-laptop-web-perception.md)

### Browser is I/O; Node is the loop

`getUserMedia` gives free AEC / NS / AGC. The browser captures mic (and optional camera), streams PCM + JSON over the perception WebSocket, and plays TTS. Node owns turn state.

- Client capture: [`web/src/lib/perception/media-capture.ts`](web/src/lib/perception/media-capture.ts)
- Session state machine: [`mastra2/src/mastra/perception/session.ts`](mastra2/src/mastra/perception/session.ts)
- Protocol types: [`web/src/lib/perception/protocol.ts`](web/src/lib/perception/protocol.ts), [`mastra2/src/mastra/perception/types.ts`](mastra2/src/mastra/perception/types.ts)
- WS server: [`mastra2/src/mastra/perception/ws-server.ts`](mastra2/src/mastra/perception/ws-server.ts)

**Privacy decision:** raw PCM/JPEG stay on the laptop. Only transcripts and short vision descriptions go to the LLM.

### Compared to Mastra + LiveKit

[Mastra’s LiveKit voice guide](https://mastra.ai/integrations/voice/livekit) validates the same split: **agent owns cognition**, a **separate realtime process** owns turn-taking, barge-in, and spoken tool feedback. Hearsay takes that design further for a **laptop presence** agent where audio never leaves the machine.

| Idea | Mastra + LiveKit | Hearsay |
|------|------------------|---------|
| Cognition | Mastra agent + memory | Same (`agent.stream` + LibSQL memory) |
| Realtime process | LiveKit Agents / room | Custom perception WS (`:4112`) |
| Mic / TTS transport | Media server / room | Browser capture + local/Kokoro/Pocket/http TTS |
| Privacy | Audio on the room path | Raw PCM/JPEG stay on the laptop |
| Barge-in | Platform / room semantics | DIY turn-yield + STT echo filter + `playbackOpen` floor |
| Tool latency | `toolFeedback` fillers | Spoken fillers in [`tool-fillers.ts`](mastra2/src/mastra/perception/tool-fillers.ts) |
| Sensors | Voice-first | Voice + webcam + one-shot screen tools |

Essay (X Article draft): [Taking Mastra’s voice design further](docs/articles/taking-mastra-voice-further.md).

**Decision:** do **not** adopt LiveKit as a runtime. Steal the patterns (generation vs speech metrics, heard-only interrupt memory, tool fillers); keep STT/TTS/AEC local.

---

## Voice loop

### Presence UI

The `/presence` page is the laptop “eyes & ears” surface: mic, optional video, scrollable conversation, HITL cards, tool log (UI-only, not spoken).

- Page: [`web/src/app/presence/page.tsx`](web/src/app/presence/page.tsx)
- App: [`web/src/components/presence/presence-app.tsx`](web/src/components/presence/presence-app.tsx)
- Conversation scroll (stick-to-bottom): [`web/src/components/presence/conversation-log.tsx`](web/src/components/presence/conversation-log.tsx)
- Settings (WS URL, TTS engine/voice): [`web/src/components/presence/presence-settings-dialog.tsx`](web/src/components/presence/presence-settings-dialog.tsx)

**Conversation UI:** latest turns stay at the bottom. Auto-scroll while pinned; scrolling up pauses; returning to the bottom (or “Jump to latest”) resumes. Live STT partials show as an ephemeral “You” line.

**Clear chat:** Presence **Clear chat** button sends `clear_session`. Voice path: ask to “start over” / “clear the chat” → agent calls `clear_conversation`. Both wipe the Mastra thread, mint a new `threadId`, reset scene working memory, and speak “Okay, starting fresh.”

### VAD is not barge-in (turn-yield)

**VAD** answers “is there speech?” **Turn-yield** answers “should the agent release the floor?”

While the agent is speaking/thinking (and barge-in is on), frames go through `TurnYieldAdapter`: soft candidate → soft-pause TTS → after sustain **and** effort → hard yield (`barge_in`).

- Cascade: [`mastra2/src/mastra/perception/turn-yield.ts`](mastra2/src/mastra/perception/turn-yield.ts)
- Tests: [`mastra2/src/mastra/perception/barge.test.ts`](mastra2/src/mastra/perception/barge.test.ts)
- Silero / energy VAD: [`mastra2/src/mastra/perception/silero-vad.ts`](mastra2/src/mastra/perception/silero-vad.ts), [`vad.ts`](mastra2/src/mastra/perception/vad.ts)

**Decision:** do **not** hard-barge on client RMS energy — that conflates coughs with interrupts. Hard stop comes from server yield or **STT-confirmed** interrupt.

### End of utterance (listen path)

With `ASR_MODE=browser`, **browser STT finals** own turn commit (`text_utterance`). Adaptive silence on PCM is advisory. With `http` ASR, adaptive silence gates Whisper finalize.

- Turn detectors: [`mastra2/src/mastra/perception/turn.ts`](mastra2/src/mastra/perception/turn.ts)
- Browser STT: [`web/src/lib/perception/browser-stt.ts`](web/src/lib/perception/browser-stt.ts)
- Content gate (noise / non-speech): [`mastra2/src/mastra/perception/content-gate.ts`](mastra2/src/mastra/perception/content-gate.ts)

### Incomplete-final hold

Browser STT sometimes finalizes mid-thought (“What’s the weather in”). Before committing, perception holds ~700 ms if the text matches a small incomplete-tail heuristic (trailing prepositions / conjunctions). A longer final cancels the hold; barge cancels it too. This is **not** semantic / LM endpointing — just a stopgap.

- Heuristic: [`mastra2/src/mastra/perception/incomplete-utterance.ts`](mastra2/src/mastra/perception/incomplete-utterance.ts)
- Wired in `onTextUtterance` in [`session.ts`](mastra2/src/mastra/perception/session.ts)

### Streaming spoken replies

Agent text is flushed to TTS in sentence-sized chunks so first audio starts before the full answer exists. Client drains a queue and sends `playback_done` when truly finished.

- Sentence split: [`mastra2/src/mastra/perception/sentences.ts`](mastra2/src/mastra/perception/sentences.ts)
- Spoken shaping: [`mastra2/src/mastra/perception/reply-text.ts`](mastra2/src/mastra/perception/reply-text.ts)
- Client playback queue: [`web/src/lib/perception/playback.ts`](web/src/lib/perception/playback.ts)

### Progress speech (talks while it works)

During tool calls and long runs the agent would otherwise go quiet for tens of seconds. A `ProgressNarrator` speaks: "Let me check." after `PROGRESS_ACK_MS` of silence, a per-tool line when a tool starts ("Searching the web."), and "Still working on it." after `PROGRESS_STILL_MS`, capped at `PROGRESS_MAX_STILL`. Line choice is request-aware (generic skills match the user's words, not the tool name); `ask_user` / `offer_choices` speak nothing (the question is the update); fillers stop once the answer streams. Narration rides the same speak FIFO as answer sentences, so playback, echo floor, and barge behave identically — and, because it is spoken outside the model stream, it never enters conversation memory (the lesson jarvis-desk-bot needed `strip_progress` for). Decision: [ADR-003](docs/adr-003-progress-speech.md).

- Narrator: [`mastra2/src/mastra/perception/progress.ts`](mastra2/src/mastra/perception/progress.ts)
- Wiring: `think()` in [`session.ts`](mastra2/src/mastra/perception/session.ts)
- Memory hygiene: [`narration-guard.ts`](mastra2/src/mastra/perception/narration-guard.ts) strips model-echoed narration lines on write via `HearsayMemory` (the jarvis-desk-bot `strip_progress` lesson, done at the write side instead of in the stream)
- Tests: [`progress.test.ts`](mastra2/src/mastra/perception/progress.test.ts), [`session.progress.test.ts`](mastra2/src/mastra/perception/session.progress.test.ts), [`narration-guard.test.ts`](mastra2/src/mastra/perception/narration-guard.test.ts), [`memory-hygiene.test.ts`](mastra2/src/mastra/memory/memory-hygiene.test.ts)

### Speakable guard (ADR-004)

Local models (Spark) drift into CJK under garbled audio, which an English browser voice cannot read. `dropUnreadableScripts` strips unreadable script (CJK/Kana/Hangul/fullwidth) from every spoken path inside `toSpokenReply`, and a wholly-unreadable answer speaks "Sorry, I didn't catch that." instead of silence. Transcript and memory keep the model's real output. One Unicode rule, no phrase-matching guards (the jarvis lesson: guards beat pattern patches, and the real fix is model choice + audio quality).

- Guard: [`mastra2/src/mastra/perception/speakable.ts`](mastra2/src/mastra/perception/speakable.ts)
- Applied in: [`reply-text.ts`](mastra2/src/mastra/perception/reply-text.ts) (`toSpokenReply`)
- Fallback wiring: `think()` in [`session.ts`](mastra2/src/mastra/perception/session.ts)
- Tests: [`speakable.test.ts`](mastra2/src/mastra/perception/speakable.test.ts), [`speakable.session.test.ts`](mastra2/src/mastra/perception/speakable.session.test.ts)

### Listen-arm after TTS

After `playback_done`, the server deafens VAD (and drops early `text_utterance`) for `LISTEN_ARM_MS` so the last words of TTS aren’t treated as the user.

- Arm logic: `beginListenArm` / `isListenArmed` in [`session.ts`](mastra2/src/mastra/perception/session.ts)
- Client spoken-text hold (~1.4s) for echo matching after queues drain: [`playback.ts`](web/src/lib/perception/playback.ts)

### Spoken tool latency fillers

While weather / search / screenshot / camera tools run, the voice floor would go silent. On `tool-call`, perception speaks a short fixed phrase once per tool name per turn (e.g. “Looking that up.”). HITL tools (`ask_user`, `offer_choices`) never get fillers — their UI is the feedback.

**Decision:** tool **UI / args** are never spoken via TTS. Fillers are latency only, not a narration of tool I/O.

- Map: [`tool-fillers.ts`](mastra2/src/mastra/perception/tool-fillers.ts)
- Stream hook in `think()` ([`session.ts`](mastra2/src/mastra/perception/session.ts))

### Heard-only interrupt memory

On barge-in, Mastra Memory may retain a longer assistant generation than the user heard. Perception snapshots `partialSpoken`, then after the aborted stream settles either **truncates** the last assistant message to the heard slice or appends a corrective note: `[Interrupted — only this was spoken]: …`.

- `interruptHeard` + `persistHeardOnlyInterrupt` in [`session.ts`](mastra2/src/mastra/perception/session.ts)
- Metric: `interrupt_heard_chars`

---

## Speaker duplex (echo / self-interrupt)

### Why speakers break naive barge-in

Browser AEC only cancels audio treated as a **WebRTC far-end**. Playing TTS via `HTMLAudioElement` / Web Audio → speakers is invisible to AEC, so residual speech hits Silero and especially browser STT.

Headphones mostly hide the problem; speakers do not.

### Engine-agnostic AEC sink

**Decision:** split synthesis from playback. Any engine that can produce a blob/PCM URL feeds one WebRTC loopback sink. Do not special-case Kokoro in the AEC path. `speechSynthesis` cannot expose samples — text echo filter only.

- Sink: [`web/src/lib/perception/webrtc-aec-playback.ts`](web/src/lib/perception/webrtc-aec-playback.ts)
- Wired from shared playback: [`playback.ts`](web/src/lib/perception/playback.ts)
- GUM constraints (`echoCancellation: { ideal: true }`): [`media-capture.ts`](web/src/lib/perception/media-capture.ts)

**Interrupt must mute the remote element** — stopping the local `AudioBufferSourceNode` alone leaves WebRTC-buffered audio playing. `stop()` zeros gain and mutes/pauses the remote `<audio>`; soft-pause ducks volume.

### Text echo filter

Compare STT partials/finals to a spoken TTS caption buffer. Mild overlap defaults (≈ iOS `isLikelyEcho`).

- Pure helpers + tests: [`web/src/lib/perception/echo-filter.ts`](web/src/lib/perception/echo-filter.ts), [`echo-filter.test.ts`](web/src/lib/perception/echo-filter.test.ts)
- Gate barge on finals (not noisy partials): [`media-capture.ts`](web/src/lib/perception/media-capture.ts)

### Server playback floor

While `playbackOpen` (first TTS → client `playback_done`), **ignore VAD soft_pause and hard_yield**. Residual speech would freeze or cut TTS. Primary hard interrupt during speak remains **STT non-echo** (client).

- `playbackOpen` in [`session.ts`](mastra2/src/mastra/perception/session.ts)

### Wait for real playback completion

`playback_done` must not fire when the local source ends but the remote WebRTC playout still has tail. Completion waits buffer duration + loopback tail; barge bumps a generation so waits abort immediately.

- Completion + barge abort: [`webrtc-aec-playback.ts`](web/src/lib/perception/webrtc-aec-playback.ts), [`playback.ts`](web/src/lib/perception/playback.ts)

---

## Vision

### Webcam tool

`request_camera_frame` asks the browser for a JPEG, then Spark describes it on a **user** message (tool-result images are not vision-safe on many OpenAI-compatible stacks).

- Tool: [`mastra2/src/mastra/tools/client-tools.ts`](mastra2/src/mastra/tools/client-tools.ts) (`requestCameraFrameTool`)
- Describe: [`mastra2/src/mastra/perception/describe-frame.ts`](mastra2/src/mastra/perception/describe-frame.ts)
- Capture: `captureCameraFrame` in [`media-capture.ts`](web/src/lib/perception/media-capture.ts)
- Working memory merge: [`mastra2/src/mastra/memory/merge-scene.ts`](mastra2/src/mastra/memory/merge-scene.ts)

### Screenshot tool (desktop help)

`capture_screenshot` uses `getDisplayMedia` (screen / window / tab picker), one JPEG, then a **UI-focused** describe prompt.

- Client helper: [`web/src/lib/perception/capture-screenshot.ts`](web/src/lib/perception/capture-screenshot.ts)
- Tool + skill: [`client-tools.ts`](mastra2/src/mastra/tools/client-tools.ts), [`mastra2/src/mastra/skills/screenshot.ts`](mastra2/src/mastra/skills/screenshot.ts)
- CopilotKit frontend tool: [`web/src/components/chat/copilot-chat-app.tsx`](web/src/components/chat/copilot-chat-app.tsx)

### Screen vs camera routing

Utterances mentioning screen/display/desktop must not auto-grab the webcam. Presence pre-grounds the user message before `generate`:

- `needsScreenshot` / `needsLiveVision`: [`describe-frame.ts`](mastra2/src/mastra/perception/describe-frame.ts)
- Pre-think capture in [`session.ts`](mastra2/src/mastra/perception/session.ts) (`captureAndDescribeScreen` vs `captureAndDescribe`)

**Lesson:** keyword auto-vision that includes “screen” will call the wrong sensor. Split intents explicitly.

---

## Client tools (browser to agent)

Agent tools that need the laptop call `ClientBridge.call(tool, args)`. Perception WS sends `client.action`; the browser replies with `tool_result`.

- Bridge: [`mastra2/src/mastra/perception/client-bridge.ts`](mastra2/src/mastra/perception/client-bridge.ts)
- Presence handler: [`presence-app.tsx`](web/src/components/presence/presence-app.tsx) `handleClientAction`
- HITL (`ask_user` / `offer_choices`): spoken or click answers; mic stays live in `awaiting_user`

**Decision:** tool UI is never spoken via TTS — keep a separate tool log in the Presence UI.

### Clear conversation tool

`clear_conversation` is a Presence-only tool (needs the perception `RequestContext` callback). It deletes the current thread, creates a new one, clears resource scene working memory, emits `session_cleared` + empty `conversation_history`, and plays a fixed confirmation.

- Tool: [`client-tools.ts`](mastra2/src/mastra/tools/client-tools.ts) (`clearConversationTool`)
- Session API: `PerceptionSession.clearConversation()` in [`session.ts`](mastra2/src/mastra/perception/session.ts)
- WS control: `clear_session` in [`ws-server.ts`](mastra2/src/mastra/perception/ws-server.ts)

---

## Agent, skills, and server tools

- Agent: [`mastra2/src/mastra/agents/hearsay-agent.ts`](mastra2/src/mastra/agents/hearsay-agent.ts)
- Skills index: [`mastra2/src/mastra/skills/index.ts`](mastra2/src/mastra/skills/index.ts)
- Spark model wiring (Completions, not Responses): [`mastra2/src/mastra/lib/model.ts`](mastra2/src/mastra/lib/model.ts)

### Date / time

Server-side tools so the model does not invent the clock.

- [`mastra2/src/mastra/tools/date-time-tool.ts`](mastra2/src/mastra/tools/date-time-tool.ts)
- Skill: [`mastra2/src/mastra/skills/date-time.ts`](mastra2/src/mastra/skills/date-time.ts)
- Optional `HEARSAY_TIMEZONE` in [`.env.example`](mastra2/.env.example)

### Weather & web search

- Weather (Open-Meteo): [`mastra2/src/mastra/tools/weather-tool.ts`](mastra2/src/mastra/tools/weather-tool.ts)
- Search (Tavily): [`mastra2/src/mastra/tools/web-search-tool.ts`](mastra2/src/mastra/tools/web-search-tool.ts)

### Memory

LibSQL-backed Mastra Memory; shared `HEARSAY_RESOURCE_ID` across CopilotKit and presence. Message history uses `lastMessages: 24`.

- [`mastra2/src/mastra/memory/hearsay-memory.ts`](mastra2/src/mastra/memory/hearsay-memory.ts)
- Scene schema: [`scene-schema.ts`](mastra2/src/mastra/memory/scene-schema.ts)

**Stable Presence thread:** the browser stores `hearsay.presence.threadId` and sends it on WS `hello`. Perception reuses or creates that Mastra thread, then emits `conversation_history` so the UI hydrates prior turns. Reconnecting the mic resumes the same conversation until **Clear chat** / `clear_conversation`.

- Thread helpers: [`web/src/lib/perception/presence-thread.ts`](web/src/lib/perception/presence-thread.ts)
- `session.init()` / `ensureThread` / `emitConversationHistory` in [`session.ts`](mastra2/src/mastra/perception/session.ts)

### Shared resource across chat and voice

Presence and CopilotKit share `HEARSAY_RESOURCE_ID` (working memory / scene). Each Presence thread id is shown in the chrome and persisted in localStorage. Deep UI merge of chat ↔ voice threads is out of scope.

---

## TTS engines

| Engine | How | Acoustic AEC |
|--------|-----|----------------|
| System `speechSynthesis` | `enqueueText` | No — text filter only |
| In-browser Kokoro | synthesize → blob → audio queue | Yes (same sink) |
| In-browser Pocket TTS | synthesize → WAV blob → audio queue | Yes (same sink) |
| HTTP sidecar (`TTS_MODE=http`) | MP3 over WS → audio queue | Yes |

- Kokoro client: [`web/src/lib/perception/kokoro-tts.ts`](web/src/lib/perception/kokoro-tts.ts)
- Pocket client: [`web/src/lib/perception/pocket-tts.ts`](web/src/lib/perception/pocket-tts.ts)
- Server TTS adapters: [`mastra2/src/mastra/perception/tts.ts`](mastra2/src/mastra/perception/tts.ts)

### Pocket built-in voices

Presence Settings → Browser TTS engine → **Pocket TTS**. Pick a Kyutai built-in (`alba`, `azelma`, …) as **Output voice = Built-in**. First load downloads ONNX weights into **Cache Storage** via [`pocket-tts-js`](https://www.npmjs.com/package/pocket-tts-js); the clone encoder is **not** required for built-ins.

Playback still goes through the shared AEC sink ([`playback.ts`](web/src/lib/perception/playback.ts)) — same path as Kokoro.

### Voice clone (separate from choosing Pocket)

Cloning is optional and opened from **Clone a voice…** (dedicated modal), not conflated with the engine picker.

1. Modal loads Pocket with `voiceCloning: true` (downloads the ~21 MB encoder if needed).
2. User records or uploads ~5–10 s of clear mono speech.
3. `cloneVoice()` encodes in a Web Worker; we persist the **reference PCM** (not the in-worker embedding) in **IndexedDB**.
4. Settings can set **Output voice = Cloned** and pick a saved id. After reload we re-run `cloneVoice` from the stored PCM.

**Decision:** clone is **client-only** under `TTS_MODE=browser`. When perception uses `TTS_MODE=http`, the server already sends MP3 — browser Pocket/clone prefs are ignored (settings shows a warning).

### Where voice data lives

| What | Store | Notes |
|------|--------|--------|
| Prefs (engine, built-in id, output source, active clone id) | `localStorage` `hearsay.presence.settings` | Metadata only |
| Cloned reference PCM + name | IndexedDB `hearsay.pocket.voices` | [`pocket-voice-store.ts`](web/src/lib/perception/pocket-voice-store.ts) |
| Model weights / `voices.bin` / encoder | Cache Storage (`pocket-tts-js`) | Cleared via library `clearCache` / site data |

UI: [`presence-settings-dialog.tsx`](web/src/components/presence/presence-settings-dialog.tsx), [`clone-voice-dialog.tsx`](web/src/components/presence/clone-voice-dialog.tsx).

---

## Event bus & metrics

Typed pub/sub between adapters and the WS layer; latency logs under `[perception:metrics]` / `[presence:metrics]`.

- [`mastra2/src/mastra/perception/bus.ts`](mastra2/src/mastra/perception/bus.ts)

### Generation vs speech

LiveKit-style split: **generation complete** ≠ **speech playout complete**.

| Metric | When |
|--------|------|
| `utterance_to_first_tts` | First spoken fragment of a turn |
| `generation_complete` | Agent stream ends (before waiting on playback) |
| `speech_complete` | Client `playback_done` (or barge / timeout); `interrupted: true\|false` |
| `tool_filler_spoken` | Latency filler played for a tool |
| `incomplete_hold` | Incomplete STT final deferred |
| `interrupt_heard_chars` | Barge snapshot of heard assistant text |

---

## What we consciously did *not* build

These are good follow-on exercises — see the [topic index in the README](README.md#learn-by-building):

- Mount perception WS on Studio’s HTTP server (single port)
- Software AEC3 / residual-echo metrics
- Prosody / LM / semantic endpointing (we only have a heuristic incomplete-final hold)
- Speculative reply generation before EOU
- Continuous screen share (we one-shot `getDisplayMedia`)
- Desktop click/type automation (screenshot is observe-only)
- LiveKit (or any media-server) runtime — patterns only

---

## Suggested reading order

1. [ADR-002](docs/adr-002-laptop-web-perception.md) — product decisions  
2. [Compared to Mastra + LiveKit](#compared-to-mastra--livekit) + [article](docs/articles/taking-mastra-voice-further.md)  
3. [`session.ts`](mastra2/src/mastra/perception/session.ts) — the loop  
4. [`media-capture.ts`](web/src/lib/perception/media-capture.ts) + [`playback.ts`](web/src/lib/perception/playback.ts) — browser half  
5. [`turn-yield.ts`](mastra2/src/mastra/perception/turn-yield.ts) + [`webrtc-aec-playback.ts`](web/src/lib/perception/webrtc-aec-playback.ts) — duplex hardness  
6. [`client-bridge.ts`](mastra2/src/mastra/perception/client-bridge.ts) + [`client-tools.ts`](mastra2/src/mastra/tools/client-tools.ts) — tools to the laptop  

