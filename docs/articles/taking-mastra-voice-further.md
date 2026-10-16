# Taking Mastra’s voice design further (local audio)

*Paste-ready draft for an X Article. Tone: collegial reply to [Mastra’s LiveKit voice guide](https://mastra.ai/integrations/voice/livekit) — standing on their shoulders, not dunking.*

---

Mastra’s LiveKit voice write-up gets something important right: **don’t bolt speech onto the Studio HTTP API**. Cognition (agent, tools, memory) and realtime turn-taking are different jobs. Split them. Let the agent stream; let a dedicated process own barge-in, spoken feedback while tools run, and the awkward gap between “the model finished generating” and “the user finished hearing it.”

We built [Hearsay](https://github.com/dcolley/hearsay) as a learning laptop “eyes and ears” stack on Mastra. We stole those ideas — then pushed the design in a direction LiveKit deliberately doesn’t own: **keep the audio on the machine**.

## Same skeleton, different media plane

If you strip brand names, the architecture rhymes:

- Mastra agent + memory for thinking  
- A long-lived realtime process for the voice loop  
- Streaming replies so first audio starts before the full answer exists  
- Interrupt handling that isn’t “VAD saw energy = stop”  
- Something to say while tools run so the floor doesn’t go dead  

LiveKit’s path puts mic and TTS on a **media server / room**. That’s the right call for multi-party, multi-device, and production voice products that want platform AEC, routing, and Ops.

Hearsay’s path puts capture, browser STT, TTS playout, and acoustic echo cancellation in the **browser**, with a small Node perception WebSocket (`:4112`) owning state. Studio stays on `:4111`. Raw PCM and JPEG never leave the laptop; only transcripts and short vision captions go to your OpenAI-compatible LLM.

That isn’t “LiveKit but worse.” It’s a different product bet: a presence surface for *your* desk, where privacy and speaker duplex matter more than rooms.

## Where we diverge (on purpose)

**1. Local audio by default.**  
Browser Web Speech for STT, system / Kokoro / Pocket / optional HTTP sidecar for TTS. No room to join. If your threat model cares about microphones, this is the headline.

**2. Speakers are a first-class problem.**  
Headphones hide echo. Speakers don’t. Browser AEC only cancels audio treated as a WebRTC far-end — so playing TTS through a naked `<audio>` element trains the mic to interrupt itself. We route every blob/PCM engine through a **WebRTC loopback sink**, keep a spoken-text echo filter on STT finals, and refuse VAD soft-pause / hard-yield while client playback is still open. Hard interrupt during speak is STT-confirmed and non-echo.

**3. DIY turn-yield, not room barge semantics.**  
VAD answers “is there speech?” Turn-yield answers “should the agent release the floor?” Soft candidate → duck TTS → sustained effort → hard yield. Residual speaker bleed must not freeze or cut the assistant mid-sentence.

**4. Laptop sensors, not voice-only.**  
Webcam frames and one-shot screen/window/tab screenshots via `getDisplayMedia`, described multimodally and grounded into the user message when the utterance asks. “Look at my screen” must not silently grab the webcam — we split those intents explicitly.

**5. Patterns LiveKit popularized, implemented locally.**  
Spoken **tool latency fillers** (“Looking that up.”) without narrating tool UI. **Heard-only interrupt memory** so barge-in doesn’t leave the full unspoken assistant draft in the thread. Explicit **generation_complete vs speech_complete** metrics. A light **incomplete-final hold** when browser STT cuts mid-thought — not a semantic EOU model, just honesty about limits.

## What we did *not* do

We did not adopt LiveKit (or Pipecat, or TEN) as a runtime. Mastra’s own docs are clear that LiveKit is the integration when you want that media plane. For Hearsay, a media server would undo the privacy bet and sink weeks into rooms we don’t need.

We also didn’t ship full LM/prosody endpointing or speculative generation before end-of-utterance. Those are good stretch goals; today the learning value is in the duplex loop you can read in one afternoon.

## Why reply in public

Mastra lowered the cost of “agent that can talk.” LiveKit lowered the cost of “voice that can interrupt.” A third lane is useful for builders who want **Mastra cognition + local laptop presence**: eyes, ears, speakers, screen — without uploading the mic.

If you’re evaluating the LiveKit guide: use it when you need rooms and platform media. If you’re building a desk agent that should *hear* your speakers without eating itself, and *see* a window when you ask — start from the same split, then keep the audio local.

Code, decisions, and maps: [github.com/dcolley/hearsay](https://github.com/dcolley/hearsay) · [LEARN.md](https://github.com/dcolley/hearsay/blob/main/LEARN.md)  
Mastra + LiveKit: [mastra.ai/integrations/voice/livekit](https://mastra.ai/integrations/voice/livekit)

---

## X thread outline (feed)

1/ Mastra’s LiveKit voice guide nails the split: agent for cognition, separate process for realtime turn-taking. We took that further for a laptop presence agent — audio stays on the machine.  

2/ Same skeleton: stream replies, barge-in that isn’t raw VAD, something to say while tools run, metrics for “generated” vs “heard.”  

3/ Different media plane: LiveKit → room / media server. Hearsay → browser STT/TTS + Node perception WS. Raw PCM/JPEG never leave the laptop.  

4/ Speakers break naive duplex. Browser AEC ignores TTS unless it’s a WebRTC far-end. We loopback every blob engine, filter STT echoes, and block VAD yield while playback is open.  

5/ Turn-yield ≠ VAD. Soft pause → sustain → hard yield. Hard stop while speaking comes from non-echo STT.  

6/ Not voice-only: webcam + one-shot screen capture, with explicit routing so “look at the screen” doesn’t grab the camera.  

7/ Stole LiveKit-shaped polish without the runtime: tool fillers, heard-only interrupt memory, generation vs speech metrics.  

8/ We did *not* adopt LiveKit. Patterns yes; media server no. Different product bet.  

9/ Stretch still open: semantic EOU, speculative gen, single-port Studio+WS. The duplex loop is the lesson.  

10/ Repo: github.com/dcolley/hearsay · Mastra LiveKit guide: mastra.ai/integrations/voice/livekit · Full write-up in the article.  
