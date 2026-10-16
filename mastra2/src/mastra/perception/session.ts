import type { Agent } from "@mastra/core/agent";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import { RequestContext } from "@mastra/core/request-context";
import type { Memory } from "@mastra/memory";
import { randomUUID } from "node:crypto";
import { hearsayResourceId } from "../memory/hearsay-memory.ts";
import { mergeFrameIntoWorkingMemory } from "../memory/merge-scene.ts";
import type { AsrAdapter } from "./asr.ts";
import { EventBus, type PerceptionEvents } from "./bus.ts";
import {
  ClientBridge,
  type ClientActionRequest,
  type ClientActionResult,
} from "./client-bridge.ts";
import { hasSpeechContent } from "./content-gate.ts";
import {
  describeScreenshotFrame,
  describeWebcamFrame,
  needsLiveVision,
  needsScreenshot,
} from "./describe-frame.ts";
import { toSpokenReply } from "./reply-text.ts";
import { firstCompleteSentence } from "./sentences.ts";
import { ProgressNarrator } from "./progress.ts";
import type { TurnAdapter } from "./turn.ts";
import {
  createTurnYieldAdapter,
  type TurnYieldAdapter,
} from "./turn-yield.ts";
import type { TtsAdapter } from "./tts.ts";
import {
  emptyScene,
  type AgentState,
  type PcmFrame,
  type SceneMemory,
} from "./types.ts";
import { SustainedSpeechGate, type VadAdapter } from "./vad.ts";
import type { VisionAdapter } from "./vision.ts";

export type SessionDeps = {
  agent: Agent;
  memory: Memory;
  vad: VadAdapter;
  turn: TurnAdapter;
  asr: AsrAdapter;
  tts: TtsAdapter;
  vision: VisionAdapter;
  halfDuplex?: boolean;
  bargeInEnabled?: boolean;
  resourceId?: string;
  /** Post-TTS deaf window before VAD can open a turn (US30). */
  listenArmMs?: number;
  /** Sustained speech before listen-start / barge-in (US17/US20). */
  sustainMs?: number;
  /** Turn-yield classifier while agent holds the floor (not VAD). */
  turnYield?: TurnYieldAdapter;
  /**
   * When true, PCM EOU does not run ASR/think — client sends text_utterance
   * (browser Web Speech API). Browser STT finals are the sole turn commit.
   */
  clientOwnsAsr?: boolean;
  /**
   * Progress speech (ADR-003): spoken updates while the agent thinks or
   * runs tools. Env fallbacks: PROGRESS_ENABLED / PROGRESS_ACK_MS /
   * PROGRESS_STILL_MS / PROGRESS_MAX_STILL.
   */
  progress?: {
    enabled?: boolean;
    ackAfterMs?: number;
    stillAfterMs?: number;
    maxStill?: number;
  };
};

const MAX_UTTERANCE_SAMPLES = 16_000 * 30;
const FIRST_AUDIO_DEADLINE_MS = 900;
const MIN_UTTERANCE_SAMPLES = 16_000 * 0.35;
const PLAYBACK_DONE_TIMEOUT_MS = 45_000;

export class PerceptionSession {
  readonly bus = new EventBus<PerceptionEvents>();
  readonly bridge = new ClientBridge();
  readonly threadId: string;
  readonly resourceId: string;

  private state: AgentState = "idle";
  private scene: SceneMemory = emptyScene();
  private partial = "";
  private utterance = "";
  private partialSpoken = "";
  private turnAbort?: AbortController;
  private pcmChunks: Int16Array[] = [];
  private pcmSamples = 0;
  private wasSpeech = false;
  /** True after sustain gate passes for the current utterance. */
  private utteranceOpened = false;
  private readonly halfDuplex: boolean;
  private readonly bargeInEnabled: boolean;
  private readonly listenArmMs: number;
  private readonly clientOwnsAsr: boolean;
  private thinking = false;

  /** Earliest t_ms when listen VAD may open a turn. */
  private listenArmedAt = 0;
  private listenArmTimer?: ReturnType<typeof setTimeout>;

  /** Progress speech options (ADR-003). */
  private readonly progressOpts: {
    enabled: boolean;
    ackAfterMs: number;
    stillAfterMs: number;
    maxStill: number;
  };

  /**
   * FIFO of TTS work so narration lines and answer sentences synthesise in
   * order — the speak generator must never overlap another.
   */
  private speakQueue: Promise<void> = Promise.resolve();

  private readonly listenSustain: SustainedSpeechGate;
  private readonly turnYield: TurnYieldAdapter;
  /** Echo floor: ignore yield candidates until this client t_ms. */
  private bargeEchoUntil = 0;
  /** Soft barge candidate active (US20 pause before hard stop). */
  private softBargePaused = false;
  /** Latest client media clock (performance.now from browser frames). */
  private lastClientTms = 0;
  /** Metrics: soft_candidate → hard_yield latency (client media clock). */
  private softBargeAt: number | null = null;
  /** Wall clock for utterance→first-TTS RTT (media clock freezes while thinking). */
  private utteranceWallStartedAt: number | null = null;
  private firstTtsLogged = false;

  private playbackDoneWaiter?: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  };
  /**
   * True from first TTS of a turn until client `playback_done`.
   * While open, VAD cannot soft_pause or hard_yield (speaker residual freezes/cuts TTS).
   * Hard interrupt during speaking remains STT non-echo (client).
   */
  private playbackOpen = false;

  constructor(private readonly deps: SessionDeps) {
    this.halfDuplex = deps.halfDuplex ?? true;
    this.bargeInEnabled = deps.bargeInEnabled ?? false;
    this.clientOwnsAsr = deps.clientOwnsAsr ?? false;
    this.listenArmMs = deps.listenArmMs ?? Number(process.env.LISTEN_ARM_MS || 700);
    const sustainMs =
      deps.sustainMs ?? Number(process.env.BARGE_IN_SUSTAIN_MS || 180);
    this.listenSustain = new SustainedSpeechGate(sustainMs);
    this.progressOpts = {
      enabled:
        deps.progress?.enabled ??
        (process.env.PROGRESS_ENABLED ?? "true").toLowerCase() !== "false",
      ackAfterMs:
        deps.progress?.ackAfterMs ?? Number(process.env.PROGRESS_ACK_MS || 3000),
      stillAfterMs:
        deps.progress?.stillAfterMs ??
        Number(process.env.PROGRESS_STILL_MS || 20000),
      maxStill:
        deps.progress?.maxStill ?? Number(process.env.PROGRESS_MAX_STILL || 6),
    };
    this.turnYield =
      deps.turnYield ?? createTurnYieldAdapter({ sustainMs });
    this.scene = deps.vision.getScene();
    this.threadId = randomUUID();
    this.resourceId = deps.resourceId || hearsayResourceId;
  }

  /** Prefer client media clock; fall back to last seen frame time. */
  private clientNow(hint?: number): number {
    if (typeof hint === "number" && Number.isFinite(hint) && hint > 0) {
      this.lastClientTms = hint;
      return hint;
    }
    return this.lastClientTms || 0;
  }

  private metric(
    name: string,
    t_ms: number,
    detail?: Record<string, number | string | boolean>,
  ): void {
    const extra = detail ? ` ${JSON.stringify(detail)}` : "";
    console.log(`[perception:metrics] ${name} t_ms=${t_ms}${extra}`);
    this.bus.emit("metric", { name, t_ms, detail });
  }

  getState(): AgentState {
    return this.state;
  }

  setClientActionSender(
    send: ((req: ClientActionRequest) => void) | null,
  ): void {
    this.bridge.setSender(send);
    // While HITL tools wait, flip UI/mic to awaiting_user (not thinking)
    this.bridge.setHitlWaitHandler((tool) => {
      if (tool === "ask_user" || tool === "offer_choices") {
        console.log(`[perception] HITL wait (${tool}) → awaiting_user`);
        this.setState("awaiting_user");
      }
    });
  }

  onToolResult(msg: ClientActionResult): void {
    this.bridge.resolveResult(msg);
    // Resume thinking badge once the user answered and the model continues
    if (this.thinking && !this.bridge.hasPending()) {
      this.setState("thinking");
    }
  }

  setState(next: AgentState): void {
    if (this.state === next) return;
    this.state = next;
    this.bus.emit("state", { state: next });
  }

  async onAudio(frame: PcmFrame): Promise<void> {
    this.clientNow(frame.t_ms);
    const vad = await Promise.resolve(this.deps.vad.process(frame));

    // Speaking / thinking: turn-yield path only (when barge enabled)
    if (this.state === "speaking" || this.state === "thinking") {
      if (this.halfDuplex && !this.bargeInEnabled) return;
      if (!this.bargeInEnabled) return;
      // Never yield-abort while ask_user (or other client tools) are waiting
      if (this.bridge.hasPending()) return;
      this.handleTurnYield(vad, frame);
      // While soft-paused or hard-yielding into listen, keep buffering speech
      if (this.softBargePaused && vad.isSpeech) {
        this.appendPcm(frame.samples);
      }
      return;
    }

    // Post-TTS deaf window (UI may show listening; VAD ignored)
    if (!this.isListenArmed(frame.t_ms)) {
      this.listenSustain.reset();
      return;
    }

    if (this.listenSustain.feed(vad.isSpeech)) {
      this.utteranceOpened = true;
    }

    // Buffer speech early; only open the turn after sustain
    if (
      (this.state === "listening" || this.state === "idle") &&
      (vad.isSpeech || (this.utteranceOpened && this.wasSpeech))
    ) {
      this.appendPcm(frame.samples);
    }

    if (this.utteranceOpened && vad.isSpeech && !this.wasSpeech) {
      this.wasSpeech = true;
      this.onSpeechStart(frame.t_ms);
    }

    if (this.utteranceOpened && this.deps.turn.onVad(vad, frame.t_ms)) {
      void this.commitTurn(frame.t_ms);
    }

    if (!vad.isSpeech) {
      this.wasSpeech = false;
      // Drop pre-sustain noise buffers — never commit without an opened utterance
      if (!this.utteranceOpened) {
        this.pcmChunks = [];
        this.pcmSamples = 0;
      }
    }
  }

  onSpeechStart(t_ms: number): void {
    if (this.state === "speaking" && this.bargeInEnabled) {
      this.bargeIn(t_ms);
    }
    this.setState("listening");
    this.partial = "";
    this.bus.emit("speech_start", { t_ms });
  }

  onTextUtterance(text: string, t_ms: number): void {
    const trimmed = text.trim();
    if (!hasSpeechContent(trimmed)) return;
    this.clientNow(t_ms);

    // Spoken answer to an in-flight ask_user — resume the agent tool, don't barge
    if (this.bridge.resolveAskUserAnswer(trimmed)) {
      console.log(
        `[perception] ask_user answered by voice: ${JSON.stringify(trimmed).slice(0, 80)}`,
      );
      this.bus.emit("partial", { text: "" });
      return;
    }

    const busy =
      this.thinking ||
      this.state === "thinking" ||
      this.state === "speaking";
    if (busy) {
      if (!this.bargeInEnabled || this.bridge.hasPending()) {
        console.log(
          `[perception] ignore text_utterance while ${this.state}: ${JSON.stringify(trimmed).slice(0, 80)}`,
        );
        return;
      }
      // Browser STT heard the interrupt — hard yield then treat as new turn
      this.metric("stt_interrupt", t_ms);
      this.bargeIn(t_ms);
    } else if (!this.isListenArmed(t_ms)) {
      // Drop trailing TTS bleed that STT finalizes during the post-playback deaf window
      console.log(
        `[perception] ignore text_utterance during listen_arm: ${JSON.stringify(trimmed).slice(0, 80)}`,
      );
      return;
    }

    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.deps.turn.reset();
    this.deps.vad.reset();
    this.listenSustain.reset();
    this.wasSpeech = false;
    this.utteranceOpened = false;
    this.utterance = trimmed;
    this.utteranceWallStartedAt = performance.now();
    this.firstTtsLogged = false;
    this.bus.emit("end_of_turn", { text: trimmed, t_ms });
    void this.think();
  }

  onBargeInRequest(t_ms: number): void {
    if (!this.bargeInEnabled) return;
    if (this.bridge.hasPending()) return;
    this.bargeIn(t_ms);
  }

  /** Client finished draining TTS queue — re-arm listen after LISTEN_ARM_MS. */
  onPlaybackDone(t_ms: number): void {
    this.playbackOpen = false;
    if (this.playbackDoneWaiter) {
      clearTimeout(this.playbackDoneWaiter.timer);
      const { resolve } = this.playbackDoneWaiter;
      this.playbackDoneWaiter = undefined;
      resolve();
    }
    void t_ms;
  }

  async onFrame(input: {
    t_ms: number;
    dataUrl: string;
    width?: number;
    height?: number;
    description?: string;
  }): Promise<void> {
    const updated = await this.deps.vision.onFrame(input);
    if (updated) {
      this.scene = updated;
      this.bus.emit("scene_update", updated);
    }

    try {
      await mergeFrameIntoWorkingMemory(
        this.deps.memory,
        {
          description: input.description,
          dataUrl: input.dataUrl,
          width: input.width,
          height: input.height,
        },
        { threadId: this.threadId, resourceId: this.resourceId },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.bus.emit("error", { error: `working memory: ${message}` });
    }
  }

  /**
   * Soft candidate → hard yield (US20) via TurnYieldAdapter.
   * Soft-pause on voiced candidate; hard yield after sustain + effort; clear if drops.
   * While client TTS is still playing, ignore VAD yield entirely — residual speech
   * would soft-pause/freeze playback and feel like a self-barge.
   */
  private handleTurnYield(
    vad: { isSpeech: boolean; energy: number },
    frame: PcmFrame,
  ): void {
    if (this.playbackOpen) {
      if (this.softBargePaused) {
        this.clearSoftBarge(frame.t_ms, /*resume*/ true);
      }
      this.turnYield.reset();
      return;
    }

    const action = this.turnYield.feed({
      t_ms: frame.t_ms,
      vad,
      ttsActive: this.state === "speaking",
      echoUntil_ms: this.bargeEchoUntil,
      agentState:
        this.state === "interrupted"
          ? "interrupted"
          : this.state === "thinking"
            ? "thinking"
            : "speaking",
    });

    if (action === "soft_candidate") {
      if (!this.softBargePaused) {
        this.softBargePaused = true;
        this.softBargeAt = frame.t_ms;
        this.metric("soft_pause", frame.t_ms);
        this.bus.emit("barge_soft_pause", { t_ms: frame.t_ms });
      }
      return;
    }

    if (action === "hard_yield") {
      if (this.softBargeAt != null) {
        this.metric("hard_yield", frame.t_ms, {
          soft_to_hard_ms: frame.t_ms - this.softBargeAt,
        });
      } else {
        this.metric("hard_yield", frame.t_ms);
      }
      this.softBargePaused = false;
      this.softBargeAt = null;
      this.bargeIn(frame.t_ms);
      return;
    }

    if (action === "clear") {
      this.clearSoftBarge(frame.t_ms, /*resume*/ true);
    }
  }

  private clearSoftBarge(t_ms: number, resume: boolean): void {
    if (!this.softBargePaused) return;
    this.softBargePaused = false;
    this.softBargeAt = null;
    if (resume && (this.state === "speaking" || this.state === "thinking")) {
      this.metric("soft_resume", t_ms);
      this.bus.emit("barge_resume", { t_ms });
    }
  }

  bargeIn(t_ms: number): void {
    if (
      this.state !== "speaking" &&
      this.state !== "thinking" &&
      this.state !== "interrupted"
    ) {
      return;
    }
    this.playbackOpen = false;
    this.softBargePaused = false;
    this.softBargeAt = null;
    this.deps.tts.stop();
    this.turnAbort?.abort();
    this.thinking = false;
    if (this.playbackDoneWaiter) {
      clearTimeout(this.playbackDoneWaiter.timer);
      this.playbackDoneWaiter.resolve();
      this.playbackDoneWaiter = undefined;
    }
    this.partialSpoken = "";
    this.turnYield.reset();
    this.setState("interrupted");
    this.bus.emit("barge_in", { t_ms });
    // Do NOT deafen with beginListenArm — keep the interrupting utterance
    this.listenArmedAt = t_ms;
    if (this.listenArmTimer) clearTimeout(this.listenArmTimer);
    this.listenArmTimer = undefined;
    this.listenSustain.reset();
    this.utteranceOpened = true;
    this.wasSpeech = true;
    this.deps.turn.reset();
    this.bus.emit("listen_arm", {
      t_ms,
      armed: true,
      until_ms: t_ms,
    });
    this.setState("listening");
  }

  private isListenArmed(t_ms: number): boolean {
    return t_ms >= this.listenArmedAt;
  }

  private beginListenArm(t_ms: number): void {
    const base = this.clientNow(t_ms);
    if (this.listenArmTimer) clearTimeout(this.listenArmTimer);
    this.listenArmedAt = base + this.listenArmMs;
    this.listenSustain.reset();
    this.utteranceOpened = false;
    this.wasSpeech = false;
    this.bus.emit("listen_arm", {
      t_ms: base,
      armed: false,
      until_ms: this.listenArmedAt,
    });
    this.listenArmTimer = setTimeout(() => {
      this.bus.emit("listen_arm", {
        t_ms: this.listenArmedAt,
        armed: true,
        until_ms: this.listenArmedAt,
      });
    }, this.listenArmMs);
  }

  private waitForPlaybackDone(): Promise<void> {
    return new Promise((resolve) => {
      if (this.playbackDoneWaiter) {
        clearTimeout(this.playbackDoneWaiter.timer);
        this.playbackDoneWaiter.resolve();
      }
      const timer = setTimeout(() => {
        this.playbackOpen = false;
        this.playbackDoneWaiter = undefined;
        resolve();
      }, PLAYBACK_DONE_TIMEOUT_MS);
      this.playbackDoneWaiter = { resolve, timer };
    });
  }

  private appendPcm(samples: Int16Array): void {
    if (this.pcmSamples >= MAX_UTTERANCE_SAMPLES) return;
    this.pcmChunks.push(samples.slice());
    this.pcmSamples += samples.length;
  }

  private concatPcm(): Int16Array {
    const out = new Int16Array(this.pcmSamples);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private async commitTurn(t_ms: number): Promise<void> {
    if (this.thinking || this.state === "thinking" || this.state === "speaking") {
      return;
    }

    const pcm = this.concatPcm();
    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.deps.turn.reset();
    this.deps.vad.reset();
    this.listenSustain.reset();
    this.wasSpeech = false;
    this.utteranceOpened = false;

    // Browser STT owns the transcript — ignore PCM EOU commits
    if (this.clientOwnsAsr) {
      this.setState("listening");
      return;
    }

    if (pcm.length < MIN_UTTERANCE_SAMPLES) {
      this.setState("idle");
      return;
    }

    try {
      this.setState("thinking");
      const text = (await this.deps.asr.finalize(pcm)).trim();
      this.deps.asr.reset();
      if (!hasSpeechContent(text)) {
        this.setState("listening");
        return;
      }
      this.utterance = text;
      this.utteranceWallStartedAt = performance.now();
      this.firstTtsLogged = false;
      this.bus.emit("end_of_turn", { text, t_ms });
      await this.think();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.bus.emit("error", { error: message });
      this.setState("listening");
    }
  }

  private async think(): Promise<void> {
    if (!hasSpeechContent(this.utterance)) {
      this.setState("listening");
      return;
    }

    if (this.thinking) {
      this.turnAbort?.abort();
    }
    this.thinking = true;
    this.turnAbort = new AbortController();
    this.setState("thinking");
    this.partialSpoken = "";

    // Progress speech (ADR-003): spoken updates while tools run. Narration is
    // queued through the same FIFO as answer sentences, outside the model
    // stream, so it never enters conversation memory.
    const narrator = new ProgressNarrator(
      {
        request: this.utterance,
        ...this.progressOpts,
      },
      () => performance.now(),
    );
    const progressTimer = this.progressOpts.enabled
      ? setInterval(() => {
          if (this.turnAbort?.signal.aborted) return;
          // While ask_user / offer_choices wait, the question is the update.
          if (this.bridge.hasPending()) return;
          const line = narrator.tick();
          if (line) this.enqueueSpeak(line);
        }, 500)
      : undefined;

    console.log(
      `[perception] think() start thread=${this.threadId} utterance=${JSON.stringify(this.utterance).slice(0, 120)}`,
    );

    const requestContext = new RequestContext();
    requestContext.set("clientBridge", this.bridge);

    // Ground visual questions before the agent answers (Spark chat cannot see
    // tool-result images). Screen/UI → screenshot; physical scene → webcam.
    let userContent = this.utterance;
    if (needsScreenshot(this.utterance)) {
      const grounded = await this.captureAndDescribeScreen(this.utterance);
      if (grounded) {
        userContent = `${this.utterance}\n\n[Live screen — trust this over memory or earlier guesses]: ${grounded}`;
      } else {
        userContent = `${this.utterance}\n\n[Screen capture unavailable or cancelled. Ask the user to allow screen/window share, or say you cannot see the display. Do not invent UI.]`;
      }
    } else if (needsLiveVision(this.utterance)) {
      const grounded = await this.captureAndDescribe(this.utterance);
      if (grounded) {
        userContent = `${this.utterance}\n\n[Live webcam — trust this over memory or earlier guesses]: ${grounded}`;
      } else {
        userContent = `${this.utterance}\n\n[Live webcam unavailable. Say you cannot see the scene. Do not invent objects, phones, or hands.]`;
      }
    }

    const messages = [
      { role: "user" as const, content: userContent },
    ] as MessageListInput;

    const t0 = performance.now();
    let rawBuf = "";
    let spokenOffset = 0;
    let spoke = false;

    const flushSpeakable = async (forceRest: boolean): Promise<void> => {
      const spoken = toSpokenReply(rawBuf);
      if (!spoken) return;

      // Only consider text we have not already spoken
      let pending = spoken.slice(spokenOffset);
      if (!pending.trim() && !forceRest) return;

      if (forceRest) {
        const rest = pending.trim();
        if (rest) {
          this.enqueueSpeak(rest);
          spoke = true;
          spokenOffset = spoken.length;
        }
        return;
      }

      // Avoid flushing while still inside a content-part JSON wrapper
      if (/^\s*\{\s*"?\s*content/i.test(rawBuf) && !/"\s*text\s*"\s*:\s*"/i.test(rawBuf)) {
        return;
      }

      while (true) {
        const cut = firstCompleteSentence(pending);
        if (cut === null) break;
        const sentence = pending.slice(0, cut).trim();
        pending = pending.slice(cut);
        spokenOffset = spoken.length - pending.length;
        if (sentence) {
          this.enqueueSpeak(sentence);
          spoke = true;
        }
      }

      // First-audio deadline: speak a clause without waiting for "." 
      if (
        !spoke &&
        performance.now() - t0 > FIRST_AUDIO_DEADLINE_MS &&
        pending.trim().length >= 12 &&
        !/^\s*\{/.test(rawBuf.trim())
      ) {
        const fragment = pending.trim();
        this.enqueueSpeak(fragment);
        spoke = true;
        spokenOffset = spoken.length;
      }
    };

    try {
      const wantsMenu = wantsOfferChoices(this.utterance);
      if (wantsMenu) {
        console.log("[perception] choice intent → require offer_choices");
      }

      const stream = await this.deps.agent.stream(messages, {
        abortSignal: this.turnAbort.signal,
        requestContext,
        memory: {
          thread: this.threadId,
          resource: this.resourceId,
        },
        ...(wantsMenu
          ? {
              toolChoice: "required" as const,
              activeTools: ["offer_choices"],
            }
          : {}),
      });

      // fullStream so tool execute (ask_user / offer_choices HITL) actually runs
      for await (const chunk of stream.fullStream) {
        if (this.turnAbort.signal.aborted) break;
        if (chunk.type === "text-delta") {
          const payload = chunk.payload as { text?: string };
          const delta = typeof payload?.text === "string" ? payload.text : "";
          if (delta) {
            narrator.onAnswerText();
            rawBuf += delta;
            await flushSpeakable(false);
          }
        } else if (
          chunk.type === "tool-call" ||
          chunk.type === "tool-result"
        ) {
          const payload = chunk.payload as { toolName?: string };
          console.log(
            `[perception] ${chunk.type}: ${payload?.toolName ?? "?"}`
          );
          if (chunk.type === "tool-call") {
            const line = narrator.onToolStart(payload?.toolName ?? "");
            if (line) this.enqueueSpeak(line);
          }
        }
      }

      if (!this.turnAbort.signal.aborted) {
        await flushSpeakable(true);
      }

      // Let every queued fragment (answer + narration) synthesise before
      // declaring the end of speech — tts_flush must not arrive early.
      await this.drainSpeakQueue();

      if (!this.turnAbort.signal.aborted) {
        if (spoke) {
          // Stay speaking until client drains TTS queue (after flush)
          this.bus.emit("tts_flush", { t_ms: this.clientNow() });
          await this.waitForPlaybackDone();
        }
        if (!this.turnAbort.signal.aborted) {
          const now = this.clientNow();
          this.bus.emit("tts_end", { t_ms: now });
          this.beginListenArm(now);
          this.setState("listening");
        }
      }
    } catch (err) {
      if (this.turnAbort.signal.aborted) {
        this.beginListenArm(this.clientNow());
        this.setState("listening");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[perception] think() error:", message);
        this.bus.emit("error", { error: message });
        this.setState("idle");
      }
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      this.thinking = false;
    }
  }

  /** Capture via client bridge + Spark multimodal user-message describe. */
  private async captureAndDescribe(reason: string): Promise<string | null> {
    try {
      const result = (await this.bridge.call("request_camera_frame", {
        reason,
      })) as {
        ok?: boolean;
        dataUrl?: string;
        width?: number;
        height?: number;
        description?: string;
      };
      if (!result?.ok || !result.dataUrl?.startsWith("data:image/")) {
        console.warn(
          "[perception] vision capture failed:",
          result?.description || "no image",
        );
        return null;
      }
      const visual = await describeWebcamFrame(result.dataUrl, { reason });
      console.log(
        `[perception] vision describe: ${JSON.stringify(visual).slice(0, 280)}`,
      );
      try {
        await mergeFrameIntoWorkingMemory(
          this.deps.memory,
          {
            description: visual,
            dataUrl: result.dataUrl,
            width: result.width,
            height: result.height,
          },
          { threadId: this.threadId, resourceId: this.resourceId },
        );
      } catch (wmErr) {
        console.warn(
          "[perception] vision WM update failed:",
          wmErr instanceof Error ? wmErr.message : wmErr,
        );
      }
      return visual;
    } catch (err) {
      console.error(
        "[perception] vision ground failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Screen/window/tab via getDisplayMedia + screenshot describe. */
  private async captureAndDescribeScreen(
    reason: string,
  ): Promise<string | null> {
    try {
      const result = (await this.bridge.call("capture_screenshot", {
        reason,
      })) as {
        ok?: boolean;
        dataUrl?: string;
        width?: number;
        height?: number;
        description?: string;
      };
      if (!result?.ok || !result.dataUrl?.startsWith("data:image/")) {
        console.warn(
          "[perception] screenshot capture failed:",
          result?.description || "no image",
        );
        return null;
      }
      const visual = await describeScreenshotFrame(result.dataUrl, { reason });
      console.log(
        `[perception] screenshot describe: ${JSON.stringify(visual).slice(0, 280)}`,
      );
      return visual;
    } catch (err) {
      console.error(
        "[perception] screenshot ground failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Queue a fragment through the speak FIFO (answer sentences + narration). */
  private enqueueSpeak(text: string): void {
    const next = this.speakQueue.then(() => this.speakFragment(text));
    this.speakQueue = next.catch((err: unknown) => {
      console.error("[perception] speak queue error:", err);
    });
  }

  /** Resolve once every queued fragment has been synthesised. */
  private async drainSpeakQueue(): Promise<void> {
    let last: Promise<void> | undefined;
    while (last !== this.speakQueue) {
      last = this.speakQueue;
      await last;
    }
  }

  private async speakFragment(text: string): Promise<void> {
    if (this.turnAbort?.signal.aborted) return;
    this.setState("speaking");
    this.playbackOpen = true;
    // Echo floor in client media clock (same base as PCM frame.t_ms)
    const now = this.clientNow();
    this.bargeEchoUntil = now + this.listenArmMs;
    this.turnYield.reset();
    if (!this.firstTtsLogged && this.utteranceWallStartedAt != null) {
      this.firstTtsLogged = true;
      this.metric("utterance_to_first_tts", now, {
        rtt_ms: Math.round(performance.now() - this.utteranceWallStartedAt),
      });
    }
    this.partialSpoken += (this.partialSpoken ? " " : "") + text;

    try {
      for await (const chunk of this.deps.tts.synthesize(text)) {
        if (this.turnAbort?.signal.aborted) break;
        this.bus.emit("tts_chunk", {
          audio: chunk.audio,
          text: chunk.text,
          mime: chunk.mime,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.bus.emit("error", { error: message });
    }
  }

  reset(): void {
    this.turnAbort?.abort();
    this.deps.tts.stop();
    this.deps.vad.reset();
    this.deps.turn.reset();
    this.turnYield.reset();
    this.deps.asr.reset();
    this.deps.vision.reset();
    this.bridge.clear();
    if (this.listenArmTimer) clearTimeout(this.listenArmTimer);
    if (this.playbackDoneWaiter) {
      clearTimeout(this.playbackDoneWaiter.timer);
      this.playbackDoneWaiter = undefined;
    }
    this.playbackOpen = false;
    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.wasSpeech = false;
    this.partial = "";
    this.utterance = "";
    this.partialSpoken = "";
    this.scene = emptyScene();
    this.thinking = false;
    this.listenSustain.reset();
    this.softBargePaused = false;
    this.softBargeAt = null;
    this.utteranceWallStartedAt = null;
    this.firstTtsLogged = false;
    this.listenArmedAt = 0;
    this.utteranceOpened = false;
    this.setState("idle");
  }
}

/** User is asking for a pick-list / menu — force offer_choices tool. */
export function wantsOfferChoices(text: string): boolean {
  return /\b(choices?|options?|menu|pick (one|from|a)|give me (a )?(list|options?|choices?)|list of|which (one|track|path))\b/i.test(
    text,
  );
}
