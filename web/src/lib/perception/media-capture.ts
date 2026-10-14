import { BrowserStt } from "./browser-stt";
import { captureScreenshotFrame } from "./capture-screenshot";
import { isLikelyEcho } from "./echo-filter";
import { FrameGrabber } from "./frame-grabber";
import { TtsPlayback } from "./playback";
import {
  encodePcmFrame,
  PCM_SAMPLE_RATE,
  type AgentState,
  type ServerHelloInfo,
  type ServerMessage,
} from "./protocol";

export type ClientAction = {
  id: string;
  tool:
    | "ask_user"
    | "offer_choices"
    | "request_camera_frame"
    | "capture_screenshot";
  args: Record<string, unknown>;
};

export type MediaCaptureHandlers = {
  onState?: (state: AgentState) => void;
  onPartial?: (text: string) => void;
  onTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (error: string) => void;
  onConnection?: (connected: boolean) => void;
  onHello?: (info: ServerHelloInfo) => void;
  onClientAction?: (action: ClientAction) => void;
  /** Voice answered an open ask_user prompt. */
  onAskUserAnswered?: (id: string, answer: string) => void;
  /** Post-TTS arm delay: false while cooling down. */
  onListenArm?: (armed: boolean) => void;
  onVideo?: (active: boolean) => void;
};

export type MediaCaptureOptions = {
  wsUrl: string;
  videoEl?: HTMLVideoElement | null;
  handlers?: MediaCaptureHandlers;
};

/**
 * Browser I/O: getUserMedia (AEC) → PCM over WS; optional camera preview + frames;
 * plays TTS from server.
 */
export class MediaCapture {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private playback = new TtsPlayback();
  private grabber: FrameGrabber | null = null;
  private muteSend = false;
  private bargeInEnabled = false;
  private lastClientBargeAt = 0;
  /** Soft-pause timestamp for cancel latency metrics (server-driven yield). */
  private softPauseAt: number | null = null;
  private agentBusy = false;
  /** When set, spoken finals answer this ask_user / offer_choices tool. */
  private pendingAskUserId: string | null = null;
  private pendingChoices: string[] | null = null;
  private asrMode = "http";
  private videoActive = false;
  private browserStt: BrowserStt | null = null;
  private sampleBuf: number[] = [];
  private readonly opts: MediaCaptureOptions;

  constructor(opts: MediaCaptureOptions) {
    this.opts = opts;
    this.playback.setOnDone(() => {
      this.sendJson({ type: "playback_done", t_ms: performance.now() });
    });
    this.playback.setOnError((message) => {
      this.opts.handlers?.onError?.(message);
    });
  }

  isVideoActive(): boolean {
    return this.videoActive;
  }

  reloadTtsSettings(): void {
    this.playback.reloadVoiceSettings();
  }

  async start(): Promise<void> {
    await this.stop();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
      },
      video: false,
    });

    this.audioCtx = new AudioContext({ sampleRate: 48_000 });
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);

      // Turn-yield is server-side (Silero + sustain + effort). Client does not
      // hard-barge on RMS energy — that conflates VAD with yield and false-cuts
      // on coughs. Hard stop comes from server barge_in or STT-confirmed interrupt.

      if (this.muteSend) return;

      const down = downsampleTo16k(input, this.audioCtx!.sampleRate);
      this.sampleBuf.push(...down);
      const frameSamples = 320; // 20 ms @ 16 kHz
      while (this.sampleBuf.length >= frameSamples) {
        const slice = this.sampleBuf.splice(0, frameSamples);
        const pcm = floatTo16(slice);
        this.ws.send(encodePcmFrame(performance.now(), pcm));
      }
    };
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(mute);
    mute.connect(this.audioCtx.destination);

    await this.connectWs();
  }

  async startVideo(): Promise<void> {
    if (this.videoActive) return;
    const videoEl = this.opts.videoEl;
    if (!videoEl) {
      throw new Error("No video element bound");
    }

    const cam = await navigator.mediaDevices.getUserMedia({
      video: { frameRate: { ideal: 15 }, width: 640, height: 480 },
      audio: false,
    });

    if (!this.stream) {
      this.stream = cam;
    } else {
      for (const track of cam.getVideoTracks()) {
        this.stream.addTrack(track);
      }
    }

    videoEl.srcObject = this.stream;
    await videoEl.play().catch(() => undefined);

    this.grabber?.stop();
    this.grabber = new FrameGrabber({
      video: videoEl,
      enableVision: true,
      onFrame: (dataUrl, meta) => {
        this.sendJson({
          type: "frame",
          t_ms: performance.now(),
          dataUrl,
          width: meta.width,
          height: meta.height,
        });
      },
    });
    this.grabber.start();
    this.videoActive = true;
    this.opts.handlers?.onVideo?.(true);
  }

  stopVideo(): void {
    this.grabber?.stop();
    this.grabber = null;

    const videoEl = this.opts.videoEl;
    if (videoEl) {
      videoEl.srcObject = null;
    }

    if (this.stream) {
      for (const track of this.stream.getVideoTracks()) {
        track.stop();
        this.stream.removeTrack(track);
      }
    }

    this.videoActive = false;
    this.opts.handlers?.onVideo?.(false);
  }

  async stop(): Promise<void> {
    this.browserStt?.stop();
    this.browserStt = null;
    this.stopVideo();
    this.playback.dispose();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.processor = null;
    this.source = null;
    await this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ws?.close();
    this.ws = null;
    this.sampleBuf = [];
    this.opts.handlers?.onConnection?.(false);
  }

  /** Drop STT barges that look like re-heard TTS (speaker bleed). */
  private shouldIgnoreSttAsEcho(text: string): boolean {
    const spoken = this.playback.getSpokenText();
    if (!spoken.trim() || !text.trim()) return false;
    if (isLikelyEcho(text, spoken)) {
      console.log(
        `[perception] stt_echo_ignored ${JSON.stringify(text.slice(0, 80))}`,
      );
      return true;
    }
    return false;
  }

  private startBrowserSttIfNeeded(): void {
    if (this.asrMode !== "browser" || this.browserStt) return;
    this.browserStt = new BrowserStt({
      onPartial: (text) => {
        if (this.pendingAskUserId) {
          this.opts.handlers?.onPartial?.(text);
          return;
        }
        if (this.agentBusy) {
          // Partials are too noisy for hard barge (TTS bleed → false interrupt).
          // Only surface UI; interrupt requires a non-echo final.
          if (this.bargeInEnabled && text.trim() && !this.shouldIgnoreSttAsEcho(text)) {
            this.opts.handlers?.onPartial?.(text);
          }
          return;
        }
        this.opts.handlers?.onPartial?.(text);
      },
      onFinal: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;

        // Voice answer for ask_user / offer_choices — resume the waiting agent tool
        if (this.pendingAskUserId) {
          const id = this.pendingAskUserId;
          const choices = this.pendingChoices;
          this.pendingAskUserId = null;
          this.pendingChoices = null;
          const result = choices
            ? matchChoiceResult(trimmed, choices)
            : { answer: trimmed };
          this.sendToolResult(id, { ok: true, result });
          this.opts.handlers?.onAskUserAnswered?.(id, trimmed);
          this.opts.handlers?.onTranscript?.(trimmed);
          return;
        }

        if (this.agentBusy) {
          if (!this.bargeInEnabled) return;
          // Echo filter only — short interrupts like "stop" / "wait" must still barge
          if (this.shouldIgnoreSttAsEcho(trimmed)) return;
          this.clientBargeIn();
          this.opts.handlers?.onTranscript?.(trimmed);
          this.sendTextUtterance(trimmed);
          return;
        }
        // Post-TTS: listen may open before STT finishes the last spoken words
        if (this.shouldIgnoreSttAsEcho(trimmed)) return;
        if (this.playback.getSpokenText().trim() && wordCount(trimmed) < 4) {
          console.log(
            `[perception] stt_echo_ignored_tail ${JSON.stringify(trimmed.slice(0, 80))}`,
          );
          return;
        }
        this.opts.handlers?.onTranscript?.(trimmed);
        this.sendTextUtterance(trimmed);
      },
      onError: (error) => this.opts.handlers?.onError?.(error),
    });
    this.browserStt.start();
  }

  /** Presence sets this when ask_user / offer_choices UI is open. */
  setPendingAskUser(id: string | null, choices?: string[] | null): void {
    this.pendingAskUserId = id;
    this.pendingChoices = choices?.length ? choices : null;
    // HITL answers need a live mic even while the agent run is still open
    if (id) {
      this.setMuteSend(false);
      this.browserStt?.setPaused(false);
    }
  }

  private syncListenForState(state: AgentState): void {
    this.agentBusy =
      state === "speaking" ||
      state === "thinking";
    // awaiting_user / open HITL: always listen for voice answers
    if (this.pendingAskUserId || state === "awaiting_user") {
      this.setMuteSend(false);
      this.browserStt?.setPaused(false);
      return;
    }
    this.setMuteSend(this.agentBusy);
    this.browserStt?.setPaused(this.agentBusy && !this.bargeInEnabled);
  }

  /** Half-duplex: mute uplink while speaking (skipped when barge-in is on). */
  setMuteSend(mute: boolean): void {
    this.muteSend = this.bargeInEnabled ? false : mute;
  }

  /** Debounced client-initiated hard barge (audio + WS). */
  private clientBargeIn(): void {
    const now = performance.now();
    if (now - this.lastClientBargeAt < 350) return;
    this.lastClientBargeAt = now;
    this.requestBargeIn();
    this.agentBusy = false;
    this.setMuteSend(false);
    this.browserStt?.setPaused(false);
  }

  sendTextUtterance(text: string): void {
    this.sendJson({
      type: "text_utterance",
      t_ms: performance.now(),
      text,
    });
  }

  sendToolResult(
    id: string,
    payload: { ok: boolean; result?: unknown; error?: string },
  ): void {
    this.sendJson({
      type: "tool_result",
      t_ms: performance.now(),
      id,
      ok: payload.ok,
      result: payload.result,
      error: payload.error,
    });
  }

  sendFrame(frame: {
    dataUrl: string;
    width?: number;
    height?: number;
    description?: string;
  }): void {
    this.sendJson({
      type: "frame",
      t_ms: performance.now(),
      dataUrl: frame.dataUrl,
      width: frame.width,
      height: frame.height,
      description: frame.description,
    });
  }

  requestBargeIn(): void {
    this.playback.stop();
    this.sendJson({ type: "barge_in", t_ms: performance.now() });
    this.sendJson({ type: "playback_done", t_ms: performance.now() });
  }

  /** Server soft-barge candidate (US20). */
  pausePlayback(): void {
    this.playback.pausePlayback();
  }

  resumePlayback(): void {
    this.playback.resumePlayback();
  }

  /** Hard stop from server barge_in — silence immediately and ack drain. */
  private onServerBargeIn(): void {
    this.playback.stop();
    this.sendJson({ type: "playback_done", t_ms: performance.now() });
    // Keep STT live for the interrupting utterance when barge-in is enabled
    if (this.bargeInEnabled) {
      this.agentBusy = false;
      this.setMuteSend(false);
      this.browserStt?.setPaused(false);
    }
  }

  async captureCameraFrame(reason?: string): Promise<{
    ok: boolean;
    description?: string;
    dataUrl?: string;
    width?: number;
    height?: number;
  }> {
    try {
      if (this.videoActive && this.opts.videoEl?.videoWidth) {
        return snapVideoFrame(this.opts.videoEl, reason);
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 450));
      const frame = snapVideoFrame(video, reason);
      stream.getTracks().forEach((t) => t.stop());
      return frame;
    } catch (err) {
      return {
        ok: false,
        description:
          err instanceof Error ? err.message : "Camera capture failed",
      };
    }
  }

  /** One-shot screen/window/tab capture (browser share picker). */
  async captureScreenshot(reason?: string): Promise<{
    ok: boolean;
    description?: string;
    dataUrl?: string;
    width?: number;
    height?: number;
  }> {
    return captureScreenshotFrame(reason);
  }

  private async connectWs(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.wsUrl);
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        this.sendJson({
          type: "hello",
          t_ms: performance.now(),
          sampleRate: PCM_SAMPLE_RATE,
        });
        this.opts.handlers?.onConnection?.(true);
        resolve();
      };
      ws.onerror = () => {
        this.opts.handlers?.onError?.("WebSocket connection failed");
        reject(new Error("WebSocket connection failed"));
      };
      ws.onclose = () => {
        this.opts.handlers?.onConnection?.(false);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data) as ServerMessage;
          void this.handleServerMessage(msg);
        } catch {
          // ignore
        }
      };
    });
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case "hello_ack":
        this.bargeInEnabled = Boolean(msg.bargeInEnabled);
        this.asrMode = msg.asrMode || "http";
        this.startBrowserSttIfNeeded();
        this.opts.handlers?.onHello?.({
          threadId: msg.threadId,
          resourceId: msg.resourceId,
          halfDuplex: msg.halfDuplex,
          bargeInEnabled: msg.bargeInEnabled,
          asrMode: msg.asrMode,
          ttsMode: msg.ttsMode,
          vadMode: msg.vadMode,
          listenArmMs: msg.listenArmMs,
          sustainMs: msg.sustainMs,
          visionEnabled: msg.visionEnabled,
        });
        break;
      case "state":
        this.opts.handlers?.onState?.(msg.state);
        this.syncListenForState(msg.state);
        break;
      case "barge_in": {
        if (this.softPauseAt != null) {
          const cancelMs = performance.now() - this.softPauseAt;
          console.info(
            `[presence:metrics] soft_to_playback_stop_ms=${Math.round(cancelMs)}`,
          );
          this.softPauseAt = null;
        }
        this.onServerBargeIn();
        break;
      }
      case "barge_soft_pause":
        this.softPauseAt = performance.now();
        this.pausePlayback();
        break;
      case "barge_resume":
        this.softPauseAt = null;
        this.resumePlayback();
        break;
      case "listen_arm":
        this.opts.handlers?.onListenArm?.(msg.armed);
        break;
      case "partial":
        this.opts.handlers?.onPartial?.(msg.text);
        break;
      case "transcript":
        this.opts.handlers?.onTranscript?.(msg.text);
        break;
      case "tts_text":
        if (msg.text) {
          this.opts.handlers?.onAssistantText?.(msg.text);
          await this.playback.enqueueText(msg.text);
        }
        break;
      case "tts_audio":
        if (msg.text) this.opts.handlers?.onAssistantText?.(msg.text);
        await this.playback.enqueueAudio(msg.base64, msg.mime, msg.text);
        break;
      case "tts_flush":
        this.playback.requestFlush();
        break;
      case "client.action":
        this.opts.handlers?.onClientAction?.({
          id: msg.id,
          tool: msg.tool,
          args: msg.args,
        });
        break;
      case "error":
        this.opts.handlers?.onError?.(msg.error);
        break;
      default:
        break;
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}

const WORD_NUMBERS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
] as const;

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
] as const;

/** Match spoken "1" / "two" / "option three" / choice label to offer_choices. */
export function matchChoiceResult(
  spoken: string,
  choices: string[],
): { choice: string; index: number; answer: string } {
  const t = spoken.trim().toLowerCase();
  const asNum = t.match(/\b([1-9])\b/);
  if (asNum) {
    const idx = Number(asNum[1]) - 1;
    if (idx >= 0 && idx < choices.length) {
      const choice = choices[idx]!;
      return { choice, index: idx, answer: choice };
    }
  }
  for (let i = 0; i < choices.length && i < WORD_NUMBERS.length; i++) {
    if (new RegExp(`\\b${WORD_NUMBERS[i]}\\b`).test(t)) {
      const choice = choices[i]!;
      return { choice, index: i, answer: choice };
    }
  }
  for (let i = 0; i < choices.length && i < ORDINALS.length; i++) {
    if (t.includes(ORDINALS[i]!)) {
      const choice = choices[i]!;
      return { choice, index: i, answer: choice };
    }
  }
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i]!;
    if (t.includes(c.toLowerCase()) || c.toLowerCase().includes(t)) {
      return { choice: c, index: i, answer: c };
    }
  }
  // Fallback: pass through so the model can interpret
  return { choice: spoken.trim(), index: -1, answer: spoken.trim() };
}

/** Capture at native aspect (max 1280 wide) — avoid the old 640×352 squash/crop. */
function snapVideoFrame(
  video: HTMLVideoElement,
  reason?: string,
): {
  ok: boolean;
  description?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
} {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) {
    return { ok: false, description: "Video has no dimensions yet" };
  }
  const maxW = 1280;
  const scale = srcW > maxW ? maxW / srcW : 1;
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
  return {
    ok: true,
    description: reason ? `Captured frame (${reason})` : "Captured frame",
    dataUrl: canvas.toDataURL("image/jpeg", 0.85),
    width,
    height,
  };
}

function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
): number[] {
  if (inputRate === PCM_SAMPLE_RATE) return Array.from(input);
  const ratio = inputRate / PCM_SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out: number[] = new Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = Math.floor(i * ratio);
    out[i] = input[idx] ?? 0;
  }
  return out;
}

function floatTo16(samples: number[]): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
