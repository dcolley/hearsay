import type { Agent } from "@mastra/core/agent";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import { RequestContext } from "@mastra/core/request-context";
import type { Memory } from "@mastra/memory";
import { randomUUID } from "node:crypto";
import { hearsayResourceId } from "../memory/hearsay-memory.ts";
import { mergeFrameIntoWorkingMemory } from "../memory/merge-scene.ts";
import {
  emptySceneWorkingMemory,
} from "../memory/scene-schema.ts";
import type { AsrAdapter } from "./asr.ts";
import { AnnounceQueue, type AnnounceMessage } from "./announce-queue.ts";
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
import {
  INCOMPLETE_UTTERANCE_HOLD_MS,
  looksIncompleteUtterance,
} from "./incomplete-utterance.ts";
import { toSpokenReply } from "./reply-text.ts";
import { NOT_CAUGHT, hasUnreadableScript } from "./speakable.ts";
import { firstCompleteSentence } from "./sentences.ts";
import { needsServerTool } from "./server-tool-intent.ts";
import { SpeculativeTurn, type SpeculationState } from "./speculation.ts";
import type { MemoryWriteGate } from "../memory/hearsay-memory.ts";
import { ProgressNarrator } from "./progress.ts";
import { toolFillerPhrase } from "./tool-fillers.ts";
import type { TurnAdapter } from "./turn.ts";
import {
  createTurnYieldAdapter,
  type TurnYieldAdapter,
} from "./turn-yield.ts";
import { ttsChunkDurationMs, type TtsAdapter } from "./tts.ts";
import {
  emptyScene,
  type AgentState,
  type ConversationTurn,
  type PcmFrame,
  type SceneMemory,
} from "./types.ts";
import { SustainedSpeechGate, type VadAdapter } from "./vad.ts";
import type { VisionAdapter } from "./vision.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isThreadId(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

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
  /** Resume this Mastra thread when valid; otherwise mint a new id. */
  threadId?: string;
  /** Post-TTS deaf window before VAD can open a turn (US30). Fallback echo floor
   *  when audio chunk durations are unavailable (mock/text-only TTS). */
  listenArmMs?: number;
  /** Extra ms past the last issued audio chunk before barge is allowed (ADR-006). */
  echoMarginMs?: number;
  /**
   * Watchdog for a stuck/absent `playback_done` ack (ms). Keeps a dead client
   * from holding the floor forever; also how tests trigger the drain-timeout
   * path without waiting out the 45 s production default.
   */
  playbackDoneTimeoutMs?: number;
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
  /**
   * Deferred announcements (ADR-008): async tool results wait for silence
   * before speaking. Env fallbacks: ANNOUNCE_SILENCE_MS / ANNOUNCE_TTL_MS.
   * `pollMs` is the drain poll timer (default 300; tests inject small values
   * the same way progress timings are injected).
   */
  announce?: {
    silenceMs?: number;
    ttlMs?: number;
    pollMs?: number;
  };
};

const MAX_UTTERANCE_SAMPLES = 16_000 * 30;
/** Smart-turn gate window: last 8 s of utterance PCM, bounded. */
const UTTERANCE_WINDOW_SAMPLES = 16_000 * 8;
const FIRST_AUDIO_DEADLINE_MS = 900;
const MIN_UTTERANCE_SAMPLES = 16_000 * 0.35;
const PLAYBACK_DONE_TIMEOUT_MS = 45_000;

/**
 * One in-flight speculative run (ADR-007). `run` is the speculative think()
 * (stream held, tools off, memory gated); `settle` resolves when the turn
 * is confirmed (commit) or abandoned (discard) so a parked stream loop can
 * finish either way.
 */
type SpeculationRun = {
  turn: SpeculativeTurn;
  abort: AbortController;
  text: string | null;
  /** ASR finalize started at likely-EOU; resolves null if discarded. */
  finalized: Promise<string | null>;
  run?: Promise<void>;
  runStarted: boolean;
  settled: boolean;
  waitSettle: Promise<"committed" | "discarded">;
  settle(r: "committed" | "discarded"): void;
};

export class PerceptionSession {
  readonly bus = new EventBus<PerceptionEvents>();
  readonly bridge = new ClientBridge();
  private _threadId: string;
  readonly resourceId: string;

  get threadId(): string {
    return this._threadId;
  }

  private state: AgentState = "idle";
  private scene: SceneMemory = emptyScene();
  private partial = "";
  private utterance = "";
  private partialSpoken = "";
  private turnAbort?: AbortController;
  private pcmChunks: Int16Array[] = [];
  private pcmSamples = 0;
  /** Bounded tail window of the current utterance (16 kHz int16) for the turn gate. */
  private windowChunks: Int16Array[] = [];
  private windowSamples = 0;
  private wasSpeech = false;
  /** True after sustain gate passes for the current utterance. */
  private utteranceOpened = false;
  private readonly halfDuplex: boolean;
  private readonly bargeInEnabled: boolean;
  private readonly listenArmMs: number;
  private readonly echoMarginMs: number;
  private readonly playbackDoneTimeoutMs: number;
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
  /**
   * Media-clock ms when the last issued TTS chunk finishes playing, derived
   * from actual chunk durations (ADR-006). 0 = no chunk data this turn.
   * Reset when playback truly ends (drain, barge, session reset).
   */
  private audioIssuedEndAt = 0;
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
  /** Avoid duplicate speech_complete when barge and playback_done both fire. */
  private speechCompleteLogged = false;
  /**
   * Text the user actually heard before barge-in (for heard-only memory).
   * Cleared after persist attempt.
   */
  private interruptHeard: string | null = null;
  /** Debounce incomplete browser-STT finals before commit. */
  private incompleteHold?: {
    text: string;
    timer: ReturnType<typeof setTimeout>;
  };

  /**
   * Speculative generation (ADR-007). speculateMs is SPECULATE_MS (0 = off,
   * behaviour bit-identical to base). The active run (null when idle/off).
   */
  private readonly speculateMs: number;
  private spec: SpeculationRun | null = null;
  /** Re-entrancy guard for the commit path (speculation awaits ASR). */
  private committing = false;

  /**
   * Deferred announcements (ADR-008): async tool results wait here until the
   * room is silent, then speak through the same FIFO. Announce clock is
   * server wall clock (Date.now), independent of the client media clock.
   */
  readonly announceQueue: AnnounceQueue;
  private readonly announcePollMs: number;
  private announcePollTimer?: ReturnType<typeof setInterval>;
  private announceDraining = false;
  /** Messages spoken by the current announce drain (barge re-queues these). */
  private announceActive: AnnounceMessage[] | null = null;
  /**
   * Progress inside `announceActive`: how many messages spoke to the END
   * through the FIFO (a fragment interrupted by a barge is NOT complete).
   * A barge re-queues only `announceActive.slice(announceSpoken)` — the
   * unfinished tail — so an already-spoken message can never play twice.
   */
  private announceSpoken = 0;
  /** Wall-clock ms of the most recent user speech event (frame/utterance/barge). */
  private lastSpeechAtMs = 0;

  /** Last think() request context (test hook for async tools outside a stream). */
  private lastRequestContext?: RequestContext;

  constructor(private readonly deps: SessionDeps) {
    this.halfDuplex = deps.halfDuplex ?? true;
    this.bargeInEnabled = deps.bargeInEnabled ?? false;
    this.clientOwnsAsr = deps.clientOwnsAsr ?? false;
    this.listenArmMs = deps.listenArmMs ?? Number(process.env.LISTEN_ARM_MS || 700);
    this.echoMarginMs =
      deps.echoMarginMs ?? Number(process.env.BARGE_ECHO_MARGIN_MS || 300);
    this.playbackDoneTimeoutMs =
      deps.playbackDoneTimeoutMs ??
      Number(process.env.PLAYBACK_DONE_TIMEOUT_MS || PLAYBACK_DONE_TIMEOUT_MS);
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
    const gated = deps.turn as unknown as Partial<{
      setWindowProvider: (fn: () => Float32Array) => void;
      setMetricHook: (
        fn: (name: string, t_ms: number, detail?: Record<string, string | number | boolean>) => void,
      ) => void;
      classifierMissing: boolean;
    }>;
    if (typeof gated.setWindowProvider === "function") {
      // Smart-turn gate: feed it the live utterance window (last 8 s).
      gated.setWindowProvider(() => this.getUtteranceWindow());
      if (typeof gated.setMetricHook === "function") {
        // Gate diagnostics (classifier failures) land on the metrics bus.
        gated.setMetricHook((name, t_ms, detail) => this.metric(name, t_ms, detail));
      }
      if (gated.classifierMissing) {
        this.metric("turn_gate", 0, { classifier: "missing", mode: "adaptive-silence" });
      }
    }
    this.scene = deps.vision.getScene();
    this._threadId = isThreadId(deps.threadId) ? deps.threadId.trim() : randomUUID();
    this.resourceId = deps.resourceId || hearsayResourceId;

    // ADR-008 deferred announcements: results land in the queue and speak at
    // the next silent moment, fed by VAD ticks, push events, and a poll.
    this.announceQueue = new AnnounceQueue({
      ...(deps.announce?.silenceMs !== undefined
        ? { silenceMs: deps.announce.silenceMs }
        : {}),
      ...(deps.announce?.ttlMs !== undefined ? { ttlMs: deps.announce.ttlMs } : {}),
      hasPendingHitl: () => this.bridge.hasPending(),
    });
    this.announcePollMs =
      deps.announce?.pollMs ?? (Number(process.env.ANNOUNCE_POLL_MS || 300) || 0);
    this.armAnnouncePoll();
    // A result landing is worth an immediate drain check (still gated on silence).
    this.announceQueue.onPushed(() => {
      void this.tryDrainAnnouncements();
    });

    // ADR-007 speculation: off by default (SPECULATE_MS=0 -> bit-identical).
    // In scope for ASR_MODE=http|mock only; browser STT owns commit otherwise.
    this.speculateMs = Number(process.env.SPECULATE_MS || 0) || 0;
    if (this.speculateMs > 0) {
      if (this.clientOwnsAsr) {
        console.warn(
          "[speculation] SPECULATE_MS>0 but ASR_MODE=browser - out of scope, speculation stays off",
        );
      } else {
        const d = deps.turn as Partial<{
          setLikelyEouCallback: (cb: ((t_ms: number) => void) | null) => void;
        }>;
        if (typeof d.setLikelyEouCallback === "function") {
          d.setLikelyEouCallback((t_ms) => this.onLikelyEou(t_ms));
          console.log(
            `[speculation] on budget=${this.speculateMs}ms advance=${Number(process.env.SPECULATE_ADVANCE_MS || 200)}ms`,
          );
        }
      }
    }
  }

  /**
   * Ensure the Mastra thread exists and push conversation_history to the client.
   * Call once after WS wiring so history subscribers are attached.
   */
  async init(): Promise<void> {
    await this.ensureThread(this._threadId);
    await this.emitConversationHistory();
  }

  private async ensureThread(threadId: string): Promise<void> {
    try {
      const existing = await this.deps.memory.getThreadById({
        threadId,
        resourceId: this.resourceId,
      });
      if (existing) {
        this._threadId = threadId;
        return;
      }
      await this.deps.memory.createThread({
        threadId,
        resourceId: this.resourceId,
        title: "Presence",
      });
      this._threadId = threadId;
    } catch (err) {
      console.warn(
        "[perception] ensureThread failed:",
        err instanceof Error ? err.message : err,
      );
      // Fall back to a fresh id if the preferred one cannot be created
      if (threadId !== this._threadId) {
        this._threadId = randomUUID();
      }
      try {
        await this.deps.memory.createThread({
          threadId: this._threadId,
          resourceId: this.resourceId,
          title: "Presence",
        });
      } catch (err2) {
        console.warn(
          "[perception] createThread fallback failed:",
          err2 instanceof Error ? err2.message : err2,
        );
      }
    }
  }

  private async emitConversationHistory(): Promise<void> {
    try {
      const recalled = await this.deps.memory.recall({
        threadId: this._threadId,
        resourceId: this.resourceId,
        perPage: 24,
      });
      const messages: ConversationTurn[] = [];
      for (const m of recalled.messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        const text = assistantPlainText(m);
        if (!text) continue;
        messages.push({ id: m.id, role: m.role, text });
      }
      this.bus.emit("conversation_history", { messages });
    } catch (err) {
      console.warn(
        "[perception] conversation history failed:",
        err instanceof Error ? err.message : err,
      );
      this.bus.emit("conversation_history", { messages: [] });
    }
  }

  /**
   * Wipe the current thread, mint a new one, clear scene working memory.
   * Used by the clear_conversation tool and client clear_session control.
   */
  async clearConversation(): Promise<{ threadId: string; resourceId: string }> {
    this.clearIncompleteHold();
    if (this.spec) this.discardSpeculation(this.spec, "clear-conversation");
    this.deps.tts.stop();
    this.turnAbort?.abort();
    // Fresh controller so we can speak a short confirmation after the wipe
    this.turnAbort = new AbortController();
    this.thinking = false;
    this.playbackOpen = false;
    // Reset discipline: the whole echo-window state goes with the thread,
    // not just playbackOpen (F4).
    this.audioIssuedEndAt = 0;
    this.bargeEchoUntil = 0;
    this.speechCompleteLogged = false;
    this.partialSpoken = "";
    this.interruptHeard = null;
    this.utterance = "";
    this.partial = "";
    // A fresh conversation drops pending async results too.
    this.announceQueue.clear();
    this.announceActive = null;
    this.announceSpoken = 0;
    if (this.playbackDoneWaiter) {
      clearTimeout(this.playbackDoneWaiter.timer);
      this.playbackDoneWaiter.resolve();
      this.playbackDoneWaiter = undefined;
    }
    this.turnYield.reset();
    this.deps.turn.reset();
    this.deps.vad.reset();
    this.deps.asr.reset();
    this.deps.vision.reset();
    this.scene = emptyScene();
    this.bridge.clear();

    const oldThreadId = this._threadId;
    try {
      await this.deps.memory.deleteThread(oldThreadId);
    } catch (err) {
      console.warn(
        "[perception] deleteThread:",
        err instanceof Error ? err.message : err,
      );
    }

    this._threadId = randomUUID();
    await this.ensureThread(this._threadId);

    try {
      await this.deps.memory.updateWorkingMemory({
        threadId: this._threadId,
        resourceId: this.resourceId,
        workingMemory: JSON.stringify(emptySceneWorkingMemory()),
      });
    } catch (err) {
      console.warn(
        "[perception] clear working memory:",
        err instanceof Error ? err.message : err,
      );
    }

    this.metric("conversation_cleared", this.clientNow(), {
      old_thread: oldThreadId.slice(0, 8),
    });
    this.bus.emit("session_cleared", {
      threadId: this._threadId,
      resourceId: this.resourceId,
    });
    this.bus.emit("conversation_history", { messages: [] });

    // Fixed confirmation — model turn was aborted when clearing mid-stream
    try {
      await this.speakFragment("Okay, starting fresh.");
      this.bus.emit("tts_flush", { t_ms: this.clientNow() });
      await this.waitForPlaybackDone();
    } catch (err) {
      console.warn(
        "[perception] clear confirmation speak failed:",
        err instanceof Error ? err.message : err,
      );
    }

    this.beginListenArm(this.clientNow());
    this.setState("listening");
    return { threadId: this._threadId, resourceId: this.resourceId };
  }

  /**
   * Clock to anchor issued-audio scheduling. Media clock once any client
   * frame/utterance has established it; server clock until then — otherwise
   * a stalled mic before the first utterance collapses the horizon toward
   * 0 and under-deafens (F6). The trade is over- vs under-deafening: when
   * client media time is unknown we err toward suppressing echo.
   */
  private scheduleNowMs(): number {
    return this.lastClientTms > 0 ? this.lastClientTms : performance.now();
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
    if (vad.isSpeech) this.lastSpeechAtMs = Date.now();

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
        this.appendWindow(frame.samples);
      }
      return;
    }

    // Post-TTS deaf window (UI may show listening; VAD ignored). The
    // residual-audio term covers the drain-timeout window where the session
    // moved back to listening but issued chunks are still audible (F1).
    if (!this.isListenArmed(frame.t_ms) || this.hasResidualEcho(frame.t_ms)) {
      this.listenSustain.reset();
      return;
    }

    if (this.listenSustain.feed(vad.isSpeech)) {
      this.utteranceOpened = true;
    }

    // ADR-007: the user resumed before the speculation was confirmed -
    // abandon it cleanly and keep the ordinary commit path timings.
    if (this.spec && this.spec.turn.active && vad.isSpeech) {
      this.discardSpeculation(this.spec, "resume");
    }

    // Buffer speech early; only open the turn after sustain
    if (
      (this.state === "listening" || this.state === "idle") &&
      (vad.isSpeech || (this.utteranceOpened && this.wasSpeech))
    ) {
      this.appendPcm(frame.samples);
      this.appendWindow(frame.samples);
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
        this.windowReset();
      }
      // Silence ticks also feed the ADR-008 announce drain gate.
      void this.tryDrainAnnouncements();
    }
  }

  onSpeechStart(t_ms: number): void {
    this.lastSpeechAtMs = Date.now();
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
    this.lastSpeechAtMs = Date.now();
    // Activity counts: a reset() disarms the announce poll, the first
    // utterance back re-arms it.
    this.armAnnouncePoll();

    // Spoken answer to an in-flight ask_user — resume the agent tool, don't barge
    if (this.bridge.resolveAskUserAnswer(trimmed)) {
      this.clearIncompleteHold();
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
      this.clearIncompleteHold();
      this.metric("stt_interrupt", t_ms);
      this.bargeIn(t_ms);
    } else if (!this.isListenArmed(t_ms) || this.hasResidualEcho(t_ms)) {
      // Drop trailing TTS bleed that STT finalizes during the post-playback
      // deaf window or while issued audio is still audible (F1).
      console.log(
        `[perception] ignore text_utterance during listen_arm/echo window: ${JSON.stringify(trimmed).slice(0, 80)}`,
      );
      return;
    }

    // Incomplete-looking finals: wait briefly for a longer final before commit
    if (!busy && looksIncompleteUtterance(trimmed)) {
      this.scheduleIncompleteHold(trimmed, t_ms);
      return;
    }
    this.clearIncompleteHold();
    this.commitTextUtterance(trimmed, t_ms);
  }

  private scheduleIncompleteHold(text: string, t_ms: number): void {
    this.clearIncompleteHold();
    this.metric("incomplete_hold", t_ms, { chars: text.length });
    console.log(
      `[perception] incomplete_hold ${JSON.stringify(text).slice(0, 80)}`,
    );
    this.incompleteHold = {
      text,
      timer: setTimeout(() => {
        this.incompleteHold = undefined;
        this.commitTextUtterance(text, this.clientNow());
      }, INCOMPLETE_UTTERANCE_HOLD_MS),
    };
  }

  private clearIncompleteHold(): void {
    if (!this.incompleteHold) return;
    clearTimeout(this.incompleteHold.timer);
    this.incompleteHold = undefined;
  }

  private commitTextUtterance(trimmed: string, t_ms: number): void {
    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.windowReset();
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
    // Playback truly ended: residual is gone, the floor decays to margin only.
    this.audioIssuedEndAt = 0;
    this.logSpeechComplete(this.clientNow(t_ms), false);
    if (this.playbackDoneWaiter) {
      clearTimeout(this.playbackDoneWaiter.timer);
      const { resolve } = this.playbackDoneWaiter;
      this.playbackDoneWaiter = undefined;
      resolve();
    }
  }

  private logSpeechComplete(t_ms: number, interrupted: boolean): void {
    if (this.speechCompleteLogged) return;
    this.speechCompleteLogged = true;
    this.metric("speech_complete", t_ms, { interrupted });
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
   * Echo floor for cascade ctx (ADR-006): what the client still has scheduled
   * at t_ms, max(0, audioIssuedEndAt - t_ms), plus echoMarginMs for room
   * radiation. With no chunk durations this turn (mock/text-only TTS), falls
   * back to the static listen-arm seed.
   */
  echoFloorAt(t_ms: number): number {
    if (this.audioIssuedEndAt > 0) {
      const residual = Math.max(0, this.audioIssuedEndAt - t_ms);
      return t_ms + residual + this.echoMarginMs;
    }
    return this.bargeEchoUntil;
  }

  /**
   * Absolute media-clock ms where the live echo suppression ends. Unlike
   * echoFloorAt (a floor that re-anchors to t_ms), this EXPIRES: once the
   * issued-audio horizon plus margin has passed, candidates are allowed, so
   * barge works again "naturally". Zero means no suppression window.
   */
  private echoWindowEndAt(): number {
    const windowEnd =
      this.audioIssuedEndAt > 0 ? this.audioIssuedEndAt + this.echoMarginMs : 0;
    return Math.max(this.bargeEchoUntil, windowEnd);
  }

  /**
   * True while audio already handed to the client may still be audible even
   * though playbackOpen is false — e.g. the drain watchdog fired while
   * scheduled chunks are still playing (F1). Mic energy in this window is
   * echo, not a barge candidate.
   */
  private hasResidualEcho(t_ms: number): boolean {
    return (
      !this.playbackOpen &&
      this.audioIssuedEndAt > 0 &&
      t_ms < this.audioIssuedEndAt + this.echoMarginMs
    );
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
      // Audio may still be scheduled client-side even though playbackOpen
      // closed (drain watchdog) — keep treating TTS as active so the dynamic
      // floor suppresses echo-derived candidates (F1/ADR-006). The window is
      // absolute so it still allows hard_yield once genuinely past.
      ttsActive: this.state === "speaking" || this.hasResidualEcho(frame.t_ms),
      echoUntil_ms: this.echoWindowEndAt(),
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
    this.clearIncompleteHold();
    this.lastSpeechAtMs = Date.now();
    // An announce caught mid-speech goes back to the queue (no loss).
    this.requeueAnnouncements(t_ms);
    const heard = this.partialSpoken.trim();
    this.interruptHeard = heard || null;
    if (heard) {
      this.metric("interrupt_heard_chars", t_ms, { chars: heard.length });
    }
    if (this.playbackOpen) {
      this.logSpeechComplete(t_ms, true);
    }
    this.playbackOpen = false;
    this.audioIssuedEndAt = 0;
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
    this.windowReset();
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
        // Watchdog only releases the floor — issued audio may still be
        // scheduled/playing client-side. KEEP audioIssuedEndAt here (a real
        // client playback_done clears it) so the dynamic echo floor keeps
        // decaying naturally until the horizon is truly past (F1/ADR-006).
        this.playbackOpen = false;
        this.logSpeechComplete(this.clientNow(), false);
        this.playbackDoneWaiter = undefined;
        resolve();
      }, this.playbackDoneTimeoutMs);
      this.playbackDoneWaiter = { resolve, timer };
    });
  }

  private appendPcm(samples: Int16Array): void {
    if (this.pcmSamples >= MAX_UTTERANCE_SAMPLES) return;
    this.pcmChunks.push(samples.slice());
    this.pcmSamples += samples.length;
  }

  /** Keep only the last UTTERANCE_WINDOW_SAMPLES in the gate window. */
  private appendWindow(samples: Int16Array): void {
    if (samples.length === 0) return;
    const kept = samples.length > UTTERANCE_WINDOW_SAMPLES
      ? samples.slice(samples.length - UTTERANCE_WINDOW_SAMPLES)
      : samples.slice();
    this.windowChunks.push(kept);
    this.windowSamples += kept.length;
    // Clamp (never negative): the counter is total appended minus dropped,
    // so it can never exceed the cap nor drift while the window is underfull.
    let excess = this.windowSamples - UTTERANCE_WINDOW_SAMPLES;
    if (excess < 0) excess = 0;
    let dropped = 0;
    while (excess > 0 && this.windowChunks.length > 1) {
      const first = this.windowChunks[0]!;
      const drop = Math.min(first.length, excess);
      if (drop === first.length) {
        this.windowChunks.shift();
      } else {
        this.windowChunks[0] = first.slice(drop);
      }
      excess -= drop;
      dropped += drop;
    }
    if (excess > 0) {
      this.windowChunks[0] = this.windowChunks[0]!.slice(excess);
      dropped += excess;
    }
    this.windowSamples -= dropped;
  }

  private windowReset(): void {
    this.windowChunks = [];
    this.windowSamples = 0;
  }

  /**
   * Last 8 s of the current utterance, zero-padded at the front, as float32
   * (int16 / 32768). Shape is always 128000 samples - the smart-turn gate's
   * classifier window.
   */
  getUtteranceWindow(): Float32Array {
    const out = new Float32Array(UTTERANCE_WINDOW_SAMPLES);
    let offset = UTTERANCE_WINDOW_SAMPLES - Math.min(this.windowSamples, UTTERANCE_WINDOW_SAMPLES);
    for (const chunk of this.windowChunks) {
      for (let i = 0; i < chunk.length; i++) out[offset++] = chunk[i]! / 32768;
    }
    return out;
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
    if (this.committing) return;
    this.committing = true;
    try {
      // ADR-007: speculation was started at likely-EOU. ASR may still be
      // finalizing; await it (the utterance buffer is still buffered for a
      // fallback commit) and promote if it is committable.
      //
      // Fix round handoff rule: an attempt that ENDS while we await (resume,
      // needs-effects / server-tool / empty / asr-error discard, budget
      // expiry, tool-intent) must NEVER swallow the confirmed turn. Exactly
      // one of these happens - promote (attempt committed, done) or fall
      // through to the ordinary commit exactly once.
      if (this.spec) {
        const spec = this.spec;
        const text = await spec.finalized;
        if (this.spec === spec) {
          // Conservative promotion (ADR-007 fix round, IMPORTANT-2b): the
          // stream is continued ONLY when the run provably could not have
          // needed tools - finalize cleared needsScreenshot, needsLiveVision,
          // wantsOfferChoices, and needsServerTool, and a stream that emitted
          // a tool-call discarded itself. Anything else never promotes.
          if (text !== null && spec.turn.state === "speculative" && spec.turn.promote()) {
            this.spec = null;
            await this.commitSpeculative(spec, text, t_ms);
            return;
          }
          this.discardSpeculation(spec, "commit-fallback");
        }
        // attempt already ended (discarded during the await): hand the turn
        // back to the ordinary path below, once.
      }
      await this.commitTurnNormal(t_ms);
    } finally {
      this.committing = false;
    }
  }

  /** Ordinary (non-speculated) PCM commit: finalize ASR now, then think. */
  private async commitTurnNormal(t_ms: number): Promise<void> {
    const pcm = this.concatPcm();
    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.windowReset();
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

  /**
   * Promote a speculative run to a confirmed turn. Called with the turn
   * already promoted (`spec.turn.promote()`). Held sentences go to the
   * speak FIFO first; then the still-running stream keeps producing into
   * the same FIFO (generation is NOT restarted); memory pending writes are
   * persisted exactly once and the write gate opens.
   */
  private async commitSpeculative(
    spec: SpeculationRun,
    text: string,
    t_ms: number,
  ): Promise<void> {
    // The utterance was finalized early - clear buffers the same way a
    // normal commit would.
    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.windowReset();
    this.deps.turn.reset();
    this.deps.vad.reset();
    this.listenSustain.reset();
    this.wasSpeech = false;
    this.utteranceOpened = false;

    this.metric("speculation_commit", t_ms, {
      held_sentences: spec.turn.held.length,
      ran_ms: t_ms - spec.turn.startedAt,
    });
    this.utterance = text;
    this.utteranceWallStartedAt = performance.now();
    this.firstTtsLogged = false;
    this.thinking = true;
    this.turnAbort = spec.abort;
    this.setState("thinking");

    // 1) Promote: speak the held buffer through the FIFO, in order.
    for (const sentence of [...spec.turn.held]) this.enqueueSpeak(sentence);
    spec.turn.drainHeld();

    // 2) Persist the speculative run's memory writes exactly once, then open
    //    the write gate for the rest of the live stream.
    await this.gateFlushAndUnblock();

    // 3) Release a parked speculative loop; then let the run finish.
    spec.settle("committed");
    this.bus.emit("end_of_turn", { text, t_ms });
    if (!spec.runStarted) {
      void this.think();
      return;
    }
    await spec.run;
  }

  /**
   * Likely-EOU hook (ADR-007), fired once per utterance by the turn detector
   * just before it would commit. Starts ASR finalize + speculative LLM
   * generation; output is held until commitTurn confirms the turn.
   */
  private onLikelyEou(t_ms: number): void {
    if (this.speculateMs <= 0 || this.clientOwnsAsr) return;
    if (this.spec || this.thinking || this.committing) return;
    if (this.state !== "listening" && this.state !== "idle") return;
    if (!this.utteranceOpened) return;
    const pcm = this.concatPcm();
    if (pcm.length < MIN_UTTERANCE_SAMPLES) return;

    let settle: (r: "committed" | "discarded") => void = () => {};
    const waitSettle = new Promise<"committed" | "discarded">((resolve) => {
      settle = (r) => {
        if (!spec.settled) {
          spec.settled = true;
          resolve(r);
        }
      };
    });
    const spec: SpeculationRun = {
      turn: new SpeculativeTurn({
        budgetMs: this.speculateMs,
        onBudgetExpired: () => this.discardSpeculation(spec, "budget"),
      }),
      abort: new AbortController(),
      text: null,
      finalized: Promise.resolve(null),
      runStarted: false,
      settled: false,
      waitSettle,
      settle: (r) => settle(r),
    };
    spec.turn.begin(t_ms);
    this.spec = spec;
    this.metric("speculation_start", t_ms, { pcm_samples: pcm.length });
    spec.finalized = this.finalizeSpeculative(spec, pcm);
  }

  /**
   * Speculative ASR finalize, then (unless excluded) start the held
   * generation run. Excluded: empty transcript, or utterances whose normal
   * path has tool/side effects before answering (screenshot / webcam
   * grounding, offer_choices menus) - speculation runs must be effect-free.
   */
  private async finalizeSpeculative(
    spec: SpeculationRun,
    pcm: Int16Array,
  ): Promise<string | null> {
    let text = "";
    try {
      text = (await this.deps.asr.finalize(pcm)).trim();
      this.deps.asr.reset();
    } catch (err) {
      console.warn(
        "[speculation] ASR finalize failed:",
        err instanceof Error ? err.message : err,
      );
      if (this.spec === spec) this.discardSpeculation(spec, "asr-error");
      return null;
    }
    if (this.spec !== spec || spec.turn.state !== "speculative") return null;
    if (!hasSpeechContent(text)) {
      this.discardSpeculation(spec, "empty");
      return null;
    }
    if (
      needsScreenshot(text) ||
      needsLiveVision(text) ||
      wantsOfferChoices(text)
    ) {
      this.discardSpeculation(spec, "needs-effects");
      return null;
    }
    // ADR-007 fix round (IMPORTANT-2a): server-tool utterances (weather,
    // web-search style) need a tool run to be truthful; a tools-off stream
    // would fabricate the answer. Never speculate them - the ordinary path
    // (tools available) handles the commit.
    if (needsServerTool(text)) {
      this.discardSpeculation(spec, "server-tool");
      return null;
    }
    spec.text = text;
    // think(spec) builds messages from this.utterance; a later ordinary
    // commit re-reads this.utterance after its own finalize.
    this.utterance = text;
    this.gateSetWritesBlocked(true);
    // Minor-1 (ADR-007 fix round): make sure the storage-domain wrapper is
    // installed BEFORE the stream's first persist, or file/remote storage
    // latency widens the first-write race past the gate.
    await this.gateEnsureInstalled();
    if (this.spec !== spec) return null; // gate install outlived the attempt
    this.startSpecRun(spec);
    return text;
  }

  /** Start (once) the speculative generation run for a finalized utterance. */
  private startSpecRun(spec: SpeculationRun): void {
    if (spec.runStarted) return;
    spec.runStarted = true;
    spec.run = this.think(spec);
  }

  /**
   * Abandon a speculation: abort the stream, drop the held buffer and all
   * timers, drop buffered memory writes, open the gate again. Structurally
   * leaves nothing behind (ADR-007; the mastra#22873 bug shape).
   */
  private discardSpeculation(spec: SpeculationRun, reason: string): void {
    const wasSpeculative = spec.turn.state === "speculative";
    spec.turn.discard();
    spec.abort.abort();
    this.gateClearAndUnblock();
    if (this.spec === spec) this.spec = null;
    spec.settle("discarded");
    if (wasSpeculative) {
      this.metric("speculation_discard", this.clientNow(), { reason });
    }
  }

  // --- memory write gate (ADR-007 step 1) ---------------------------------

  private gate(): MemoryWriteGate | null {
    const m = this.deps.memory as unknown as Partial<MemoryWriteGate>;
    return typeof m.blockWrites === "function" ? (m as MemoryWriteGate) : null;
  }

  private gateSetWritesBlocked(on: boolean): void {
    this.gate()?.blockWrites(on);
  }

  /**
   * Install the storage-domain wrapper (Minor-1): must resolve before the
   * first speculative stream so its early writes hit the buffer, not storage.
   */
  private async gateEnsureInstalled(): Promise<void> {
    const g = this.gate() as Partial<MemoryWriteGate> | null;
    if (typeof g?.ensureWriteGate === "function") await g.ensureWriteGate();
  }

  /**
   * Persist everything buffered, then open the gate, as ONE ordered step
   * (Minor-2): flushPending -> unblock leaves a window where a stream write
   * racing the commit is buffered after the flush and lands late or never.
   */
  private async gateFlushAndUnblock(): Promise<void> {
    const g = this.gate();
    if (!g) return;
    if (typeof g.flushAndUnblock === "function") {
      await g.flushAndUnblock();
      return;
    }
    await g.flushPending();
    g.blockWrites(false);
  }

  private gateClearAndUnblock(): void {
    const g = this.gate();
    if (!g) return;
    g.clearPending();
    g.blockWrites(false);
  }

  /** Test/debug hook: current speculation state, "off" when disabled. */
  debugSpeculation(): SpeculationState | "off" {
    if (this.speculateMs <= 0) return "off";
    return this.spec?.turn.state ?? "idle";
  }

  /** Test hook: the request context of the last think() (async tools that
   *  run outside a real stream, e.g. integration fixtures). */
  debugRequestContext(): RequestContext {
    return this.lastRequestContext ?? new RequestContext();
  }

  private async think(spec?: SpeculationRun): Promise<void> {
    if (!hasSpeechContent(this.utterance)) {
      if (!spec) this.setState("listening");
      return;
    }

    if (spec) {
      // Speculative phase: the session keeps listening; commit sets thinking
      // state and adopts spec.abort. No state flips, no progress narration
      // (nothing audible is allowed before the user commits).
    } else {
      if (this.thinking) {
        this.turnAbort?.abort();
      }
      this.thinking = true;
      this.turnAbort = new AbortController();
      this.setState("thinking");
    }
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
    const progressTimer =
      this.progressOpts.enabled && !spec
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
    requestContext.set("clearConversation", () => this.clearConversation());
    // ADR-008: tools observe turn cancellation via context.abortSignal (the
    // stream loop forwards the stream's abortSignal into the tool execute
    // context); this key is the documented fallback for wrappers that build
    // their own context. The queue carries async results (gap 4).
    requestContext.set("announceQueue", this.announceQueue);
    this.lastRequestContext = requestContext;

    // Ground visual questions before the agent answers (Spark chat cannot see
    // tool-result images). Screen/UI → screenshot; physical scene → webcam.
    // Speculative runs skip this: client capture is a tool effect and effects
    // before commit are out of scope (such utterances are discarded earlier).
    let userContent = this.utterance;
    if (!spec && needsScreenshot(this.utterance)) {
      const grounded = await this.captureAndDescribeScreen(this.utterance);
      if (grounded) {
        userContent = `${this.utterance}\n\n[Live screen — trust this over memory or earlier guesses]: ${grounded}\n\nDo not call capture_screenshot again this turn; the display is already described above.`;
      } else {
        userContent = `${this.utterance}\n\n[Screen capture unavailable or cancelled. Ask the user to allow screen/window share, or say you cannot see the display. Do not invent UI.]`;
      }
    } else if (!spec && needsLiveVision(this.utterance)) {
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

    // ADR-007: speculative runs abort through spec.abort (owned by the
    // speculation machinery); live runs through this.turnAbort.
    const abortSignal = spec ? spec.abort.signal : this.turnAbort!.signal;

    // ADR-008 turn cancellation: the stream loop forwards this signal into
    // every tool execute context as `context.abortSignal`; the requestContext
    // copy is the documented fallback (see with-contract.ts).
    this.lastRequestContext?.set("turnAbortSignal", abortSignal);

    const t0 = performance.now();
    let rawBuf = "";
    let spokenOffset = 0;
    let spoke = false;
    let sawUnreadable = false;
    const fillersSpoken = new Set<string>();

    const flushSpeakable = async (forceRest: boolean): Promise<void> => {
      const spoken = toSpokenReply(rawBuf);
      if (!spoken) return;

      // Only consider text we have not already spoken
      let pending = spoken.slice(spokenOffset);
      if (!pending.trim() && !forceRest) return;

      // ADR-007: while a speculation is still uncommitted, generated
      // sentences go to the HELD buffer - never spoken, never tts_flush.
      // After commit (or with speculation off) they go to the speak FIFO.
      const emitOrHold = (sentence: string): void => {
        if (spec && spec.turn.state === "speculative") spec.turn.hold(sentence);
        else this.enqueueSpeak(sentence);
        spoke = true;
      };

      if (forceRest) {
        const rest = pending.trim();
        if (rest) {
          emitOrHold(rest);
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
          emitOrHold(sentence);
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
        emitOrHold(fragment);
        spokenOffset = spoken.length;
      }
    };

    try {
      const wantsMenu = wantsOfferChoices(this.utterance);
      if (wantsMenu) {
        console.log("[perception] choice intent → require offer_choices");
      }

      // ADR-007: speculative streams run with tools OFF - no tool may
      // execute before the turn is committed. After commit the same stream
      // continues (options were fixed at request time; a speculative stream
      // that wanted a tool was discarded at first tool-call).
      const specMode = !!spec && spec.turn.state === "speculative";
      const stream = await this.deps.agent.stream(messages, {
        abortSignal,
        requestContext,
        memory: {
          thread: this.threadId,
          resource: this.resourceId,
        },
        ...(specMode ? { toolChoice: "none" as const } : {}),
        ...(wantsMenu
          ? {
              toolChoice: "required" as const,
              activeTools: ["offer_choices"],
            }
          : {}),
      });

      // fullStream so tool execute (ask_user / offer_choices HITL) actually runs
      for await (const chunk of stream.fullStream) {
        if (abortSignal.aborted) break;
        if (chunk.type === "text-delta") {
          const payload = chunk.payload as { text?: string };
          const delta = typeof payload?.text === "string" ? payload.text : "";
          if (delta) {
            narrator.onAnswerText();
            if (hasUnreadableScript(delta)) {
              if (!sawUnreadable) {
                sawUnreadable = true;
                console.warn(
                  "[perception] model emitted unreadable script (CJK?); it was dropped before TTS",
                );
              }
            }
            rawBuf += delta;
            await flushSpeakable(false);
          }
        } else if (
          chunk.type === "tool-call" ||
          chunk.type === "tool-result"
        ) {
          const payload = chunk.payload as { toolName?: string };
          const toolName = payload?.toolName ?? "?";
          console.log(`[perception] ${chunk.type}: ${toolName}`);
          if (chunk.type === "tool-call" && spec && spec.turn.state === "speculative") {
            // The model wants a tool despite toolChoice:"none" (or a stream
            // predating commit). Tool effects never run speculatively: drop
            // this speculation; the confirmed turn re-runs the normal path.
            console.log("[speculation] tool intent -> discard");
            this.discardSpeculation(spec, "tool-intent");
            break;
          }
          if (chunk.type === "tool-call") {
            // ADR-003 owns known tools. Local fillers cover names the
            // narrator does not (and stay silent when a progress line fires).
            // Both respect PROGRESS_ENABLED=false (silent until the answer).
            if (this.progressOpts.enabled) {
              const line = narrator.onToolStart(
                toolName === "?" ? "" : toolName,
              );
              if (line) {
                this.enqueueSpeak(line);
              } else {
                const filler = toolFillerPhrase(
                  toolName === "?" ? undefined : toolName,
                );
                if (filler && !fillersSpoken.has(toolName)) {
                  fillersSpoken.add(toolName);
                  this.metric("tool_filler_spoken", this.clientNow(), {
                    tool: toolName,
                  });
                  this.enqueueSpeak(filler);
                  spoke = true;
                }
              }
            }
          }
        }
      }

      const genAt = this.clientNow();
      this.metric("generation_complete", genAt, {
        aborted: abortSignal.aborted,
        spoke,
        ...(spec ? { speculation: true } : {}),
      });

      if (!abortSignal.aborted) {
        await flushSpeakable(true);
      }

      if (spec) {
        if (spec.turn.state === "discarded") return;
        if (spec.turn.state === "speculative") {
          // Stream finished before the turn was confirmed. Park until the
          // session commits (promotes) or discards; then finish normally.
          await spec.waitSettle;
          if ((spec.turn.state as SpeculationState) === "discarded") return;
        }
      }

      // ADR-004: the model said something, but none of it was speakable
      // (local-model CJK drift) — be honest out loud instead of silent.
      if (!abortSignal.aborted && !spoke && sawUnreadable) {
        this.enqueueSpeak(NOT_CAUGHT);
        spoke = true;
        this.metric("unreadable_answer_guarded", this.clientNow());
      }

      // Let every queued fragment (answer + narration) synthesise before
      // declaring the end of speech — tts_flush must not arrive early.
      await this.drainSpeakQueue();

      if (!abortSignal.aborted) {
        if (spoke) {
          // Stay speaking until client drains TTS queue (after flush)
          this.bus.emit("tts_flush", { t_ms: this.clientNow() });
          await this.waitForPlaybackDone();
        }
        if (!abortSignal.aborted) {
          const now = this.clientNow();
          this.bus.emit("tts_end", { t_ms: now });
          this.beginListenArm(now);
          this.setState("listening");
        }
      } else {
        // A discarded speculation never spoke and never persisted: skip the
        // heard-only interrupt bookkeeping entirely.
        if (!spec || spec.turn.state !== "discarded") {
          await this.persistHeardOnlyInterrupt();
        }
      }
    } catch (err) {
      if (spec && spec.turn.state === "discarded") {
        // speculative stream aborted by design - silent, no memory, no audio
        return;
      }
      if (spec && spec.turn.state === "speculative" && abortSignal.aborted) {
        this.discardSpeculation(spec, "stream-aborted");
        return;
      }
      if (abortSignal.aborted) {
        await this.persistHeardOnlyInterrupt();
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

  /**
   * After barge-in: keep memory aligned with what the user actually heard,
   * not the full (unspoken) assistant generation.
   */
  private async persistHeardOnlyInterrupt(): Promise<void> {
    const heard = this.interruptHeard?.trim() ?? "";
    this.interruptHeard = null;
    if (!heard) return;

    try {
      const recalled = await this.deps.memory.recall({
        threadId: this.threadId,
        resourceId: this.resourceId,
        perPage: 12,
      });
      const lastAssistant = [...recalled.messages]
        .reverse()
        .find((m) => m.role === "assistant");

      if (lastAssistant) {
        const existing = assistantPlainText(lastAssistant);
        if (
          existing &&
          existing.length > heard.length &&
          (existing.startsWith(heard.slice(0, Math.min(48, heard.length))) ||
            heard.startsWith(existing.slice(0, Math.min(48, existing.length))))
        ) {
          await this.deps.memory.updateMessages({
            messages: [
              {
                id: lastAssistant.id,
                content: {
                  format: 2,
                  parts: [{ type: "text", text: heard }],
                  content: heard,
                },
              },
            ],
          });
          console.log(
            `[perception] interrupt memory truncated to ${heard.length} chars`,
          );
          return;
        }
      }

      await this.deps.memory.saveMessages({
        messages: [
          {
            id: randomUUID(),
            role: "user",
            threadId: this.threadId,
            resourceId: this.resourceId,
            createdAt: new Date(),
            content: {
              format: 2,
              parts: [
                {
                  type: "text",
                  text: `[Interrupted — only this was spoken]: ${heard}`,
                },
              ],
              content: `[Interrupted — only this was spoken]: ${heard}`,
            },
          },
        ],
      });
      console.log(
        `[perception] interrupt memory note saved (${heard.length} chars)`,
      );
    } catch (err) {
      console.warn(
        "[perception] heard-only memory failed:",
        err instanceof Error ? err.message : err,
      );
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

  // --- deferred announcements (ADR-008) ------------------------------------

  /** Small hysteresis so "just spoke" still counts as not silent. */
  private static readonly ANNOUNCE_QUIET_MS = 150;

  /**
   * (Re-)arm the drain poll. Idempotent. Called by the constructor and
   * lazily by the first activity after a `reset()` stopped it — a closed
   * session must not keep an interval pinning it to the process.
   */
  private armAnnouncePoll(): void {
    if (this.announcePollMs <= 0 || this.announcePollTimer) return;
    this.announcePollTimer = setInterval(() => {
      void this.tryDrainAnnouncements();
    }, this.announcePollMs);
    this.announcePollTimer.unref?.();
  }

  /** Disarm the drain poll (nothing scheduled may survive a reset). */
  private stopAnnouncePoll(): void {
    if (this.announcePollTimer) {
      clearInterval(this.announcePollTimer);
      this.announcePollTimer = undefined;
    }
  }

  /**
   * Drain gated announcements into the speak FIFO when the room is really
   * quiet: never over a live turn (thinking / speaking / playback) and never
   * while speculation holds the floor. `tts_flush` fires only after the FIFO
   * drains, and the announce speaks through the ordinary FIFO so playback,
   * echo floor, and barge behave like any other speech.
   */
  private async tryDrainAnnouncements(): Promise<void> {
    if (this.announceDraining) return;
    if (this.thinking || this.spec) return;
    const stateNow: AgentState = this.getState();
    if (stateNow === "thinking" || stateNow === "speaking") return;
    if (this.playbackOpen) return;
    const now = Date.now();
    const isSilent = now - this.lastSpeechAtMs >= PerceptionSession.ANNOUNCE_QUIET_MS;
    const first = this.announceQueue.maybeDrain(now, isSilent, false);
    if (!first) return;
    const batch: AnnounceMessage[] = [first];
    for (;;) {
      const next = this.announceQueue.maybeDrain(now, isSilent, false);
      if (!next) break;
      batch.push(next);
    }

    this.announceDraining = true;
    this.announceActive = batch;
    this.announceSpoken = 0;
    // Fresh controller so a barge-in during the announce itself can stop it
    // (speakFragment breaks on the abort signal), same contract as a turn.
    const speakAbort = new AbortController();
    this.turnAbort = speakAbort;
    try {
      batch.forEach((msg, index) =>
        this.enqueueAnnounceSpeak(msg, index, batch, speakAbort),
      );
      await this.drainSpeakQueue();
      const afterQueue: AgentState = this.getState();
      if (!speakAbort.signal.aborted && afterQueue === "speaking") {
        this.metric("announce_drained", this.clientNow(), {
          count: batch.length,
          tools: batch.map((m) => m.tool ?? "?").join(","),
        });
        this.bus.emit("tts_flush", { t_ms: this.clientNow() });
        await this.waitForPlaybackDone();
        if (!speakAbort.signal.aborted) {
          const doneAt = this.clientNow();
          this.bus.emit("tts_end", { t_ms: doneAt });
          this.beginListenArm(doneAt);
          this.setState("listening");
        }
      }
    } finally {
      this.announceDraining = false;
      if (this.announceActive === batch) this.announceActive = null;
    }
  }

  /**
   * Announce-specific FIFO enqueue: like `enqueueSpeak` but it records
   * per-message speak progress (`announceSpoken`) so a barge can re-queue
   * exactly the unfinished tail. A message counts as spoken only when its
   * fragment ran to the end without the batch being aborted.
   */
  private enqueueAnnounceSpeak(
    msg: AnnounceMessage,
    index: number,
    batch: AnnounceMessage[],
    speakAbort: AbortController,
  ): void {
    const next = this.speakQueue.then(async () => {
      // The batch was barged (or another controller took the FIFO): do not
      // start this fragment — it is already back in the queue for a retry,
      // and speaking it here as well would announce it twice.
      if (speakAbort.signal.aborted || this.turnAbort !== speakAbort) return;
      await this.speakFragment(msg.text);
      if (!speakAbort.signal.aborted && this.announceActive === batch) {
        this.announceSpoken = Math.max(this.announceSpoken, index + 1);
      }
    });
    this.speakQueue = next.catch((err: unknown) => {
      console.error("[perception] speak queue error:", err);
    });
  }

  /**
   * A barge-in that caught the announce mid-speech: re-queue what was NOT
   * finished so the result lands at the next silent moment - interruption
   * must not lose a result (ADR-008). Only the tail past `announceSpoken`
   * goes back: messages already spoken to the end must never play twice.
   */
  private requeueAnnouncements(t_ms: number): void {
    if (!this.announceActive) return;
    const tail = this.announceActive.slice(this.announceSpoken);
    this.announceActive = null;
    if (tail.length === 0) return;
    const now = Date.now();
    for (const msg of [...tail].reverse()) {
      this.announceQueue.requeue({ id: msg.id, tool: msg.tool, text: msg.text }, now);
    }
    this.metric("announce_requeued", t_ms, { count: tail.length });
  }

  private async speakFragment(text: string): Promise<void> {
    if (this.turnAbort?.signal.aborted) return;
    this.setState("speaking");
    if (!this.playbackOpen) {
      this.speechCompleteLogged = false;
    }
    this.playbackOpen = true;
    // Static echo-floor fallback in client media clock (same base as frame
    // t_ms). Used only when no chunk durations are available (ADR-006); the
    // live floor is audioIssuedEndAt + margin, updated per issued chunk.
    const now = this.clientNow();
    this.bargeEchoUntil = this.scheduleNowMs() + this.listenArmMs;
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
        // Dynamic echo floor: extend past the audio we just handed the client
        // (ADR-006). No derivable duration (text/MP3) leaves the static seed.
        const durationMs = ttsChunkDurationMs(chunk);
        if (durationMs != null) {
          this.audioIssuedEndAt =
            Math.max(this.audioIssuedEndAt, this.scheduleNowMs()) + durationMs;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.bus.emit("error", { error: message });
    }
  }

  reset(): void {
    this.turnAbort?.abort();
    if (this.spec) this.discardSpeculation(this.spec, "reset");
    this.deps.tts.stop();
    this.deps.vad.reset();
    this.deps.turn.reset();
    this.turnYield.reset();
    this.deps.asr.reset();
    this.deps.vision.reset();
    this.bridge.clear();
    this.announceQueue.clear();
    this.announceActive = null;
    this.announceSpoken = 0;
    // The poll interval must NOT survive a reset: ws-server resets on WS
    // close, and an uncleared interval pins the closed session forever.
    // It re-arms lazily on the next activity (onTextUtterance).
    this.stopAnnouncePoll();
    this.clearIncompleteHold();
    if (this.listenArmTimer) clearTimeout(this.listenArmTimer);
    if (this.playbackDoneWaiter) {
      clearTimeout(this.playbackDoneWaiter.timer);
      this.playbackDoneWaiter = undefined;
    }
    this.playbackOpen = false;
    this.audioIssuedEndAt = 0;
    this.speechCompleteLogged = false;
    this.interruptHeard = null;
    this.pcmChunks = [];
    this.pcmSamples = 0;
    this.windowReset();
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

/** Flatten assistant message parts to plain text for interrupt truncation. */
function assistantPlainText(message: {
  content?: { parts?: Array<{ type?: string; text?: string }>; content?: string };
}): string {
  const parts = message.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("")
      .trim();
  }
  const c = message.content?.content;
  return typeof c === "string" ? c.trim() : "";
}

/** User is asking for a pick-list / menu — force offer_choices tool. */
export function wantsOfferChoices(text: string): boolean {
  return /\b(choices?|options?|menu|pick (one|from|a)|give me (a )?(list|options?|choices?)|list of|which (one|track|path))\b/i.test(
    text,
  );
}
