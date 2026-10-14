import { synthesizeKokoroUrl } from "./kokoro-tts";
import {
  loadPresenceSettings,
  type BrowserTtsEngine,
} from "./presence-settings";
import { WebrtcAecPlayback } from "./webrtc-aec-playback";

/**
 * TTS playback with hard-stop for barge-in.
 * Audio and text both use a queue — never cancel on enqueue.
 * `playback_done` fires only after an explicit flush (end of assistant turn).
 *
 * Blob/PCM audio (Kokoro, HTTP, any future engine that lands in the audio
 * queue) plays through a WebRTC loopback sink so browser AEC can cancel it.
 * `speechSynthesis` cannot expose samples — it speaks directly and still
 * updates the spoken-text buffer for the echo filter.
 */
export class TtsPlayback {
  private aec = new WebrtcAecPlayback();
  private audioQueue: string[] = [];
  private textQueue: string[] = [];
  private drainingAudio = false;
  private drainingText = false;
  private generation = 0;
  private flushRequested = false;
  private onDone?: () => void;
  private onError?: (message: string) => void;
  private voiceURI = "";
  private speechRate = 1;
  private browserTtsEngine: BrowserTtsEngine = "speechSynthesis";
  private kokoroVoice = "af_heart";
  private kokoroFailNotified = false;
  /** Captions for STT echo filter — all engines append here. */
  private spokenText = "";
  /** Keep captions after playback so trailing STT of last words still matches. */
  private spokenClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Acoustic / STT lag after speakers go quiet (ms). */
  private static readonly ECHO_HOLD_MS = 1400;
  /** Direct HTMLAudioElement fallback (when AEC sink fails) — must stop on barge. */
  private directAudio: HTMLAudioElement | null = null;

  constructor() {
    this.reloadVoiceSettings();
  }

  reloadVoiceSettings(): void {
    const s = loadPresenceSettings();
    this.voiceURI = s.voiceURI;
    this.speechRate = s.speechRate;
    this.browserTtsEngine = s.browserTtsEngine;
    this.kokoroVoice = s.kokoroVoice;
  }

  setOnDone(cb: (() => void) | undefined): void {
    this.onDone = cb;
  }

  setOnError(cb: ((message: string) => void) | undefined): void {
    this.onError = cb;
  }

  /** Spoken TTS captions so far this turn (for echo filter). */
  getSpokenText(): string {
    return this.spokenText;
  }

  private appendSpoken(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.cancelSpokenClear();
    this.spokenText = this.spokenText ? `${this.spokenText} ${t}` : t;
  }

  private cancelSpokenClear(): void {
    if (this.spokenClearTimer != null) {
      clearTimeout(this.spokenClearTimer);
      this.spokenClearTimer = null;
    }
  }

  private scheduleSpokenClear(): void {
    this.cancelSpokenClear();
    this.spokenClearTimer = setTimeout(() => {
      this.spokenClearTimer = null;
      this.spokenText = "";
    }, TtsPlayback.ECHO_HOLD_MS);
  }

  /**
   * Server finished enqueueing this turn — emit onDone when queues drain
   * (or immediately if already idle).
   */
  requestFlush(): void {
    this.flushRequested = true;
    this.maybeDone(this.generation);
  }

  async enqueueAudio(
    base64: string,
    mime: string,
    text?: string,
  ): Promise<void> {
    if (text) this.appendSpoken(text);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    this.audioQueue.push(url);
    if (!this.drainingAudio) void this.drainAudio(this.generation);
  }

  /** Queue a line; speak in order. Never cancel previous lines here. */
  enqueueText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || typeof window === "undefined") return;
    this.reloadVoiceSettings();
    this.appendSpoken(trimmed);
    this.textQueue.push(trimmed);
    if (!this.drainingText) void this.drainText(this.generation);
  }

  /** Hard cut — silence immediately, no fade. */
  stop(): void {
    this.generation += 1;
    this.audioQueue = [];
    this.textQueue = [];
    this.drainingAudio = false;
    this.drainingText = false;
    this.flushRequested = false;
    this.cancelSpokenClear();
    this.spokenText = "";
    this.aec.stop();
    this.stopDirectAudio();
    if (typeof window !== "undefined") {
      window.speechSynthesis.cancel();
    }
  }

  private stopDirectAudio(): void {
    if (!this.directAudio) return;
    try {
      this.directAudio.pause();
      this.directAudio.removeAttribute("src");
      this.directAudio.load();
    } catch {
      // ignore
    }
    this.directAudio = null;
  }

  /** Tear down WebRTC AEC peers (call when Presence session ends). */
  dispose(): void {
    this.stop();
    this.aec.close();
  }

  /** US20: resume after a false barge-in candidate (soft-pause path). */
  resumePlayback(): void {
    if (typeof window !== "undefined" && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
    if (this.directAudio?.paused) {
      void this.directAudio.play().catch(() => undefined);
    }
    this.aec.resume();
  }

  /** Soft-pause / duck for tentative barge-in candidates (before hard stop). */
  pausePlayback(): void {
    if (typeof window !== "undefined") {
      window.speechSynthesis.pause();
    }
    if (this.directAudio) {
      this.directAudio.volume = 0.12;
      this.directAudio.pause();
    }
    this.aec.pause();
  }

  private maybeDone(gen: number): void {
    if (
      gen !== this.generation ||
      !this.flushRequested ||
      this.drainingAudio ||
      this.drainingText ||
      this.audioQueue.length > 0 ||
      this.textQueue.length > 0
    ) {
      return;
    }
    // Queues empty — still wait until engines are quiet (AEC loopback / speechSynthesis).
    // Barge bumps generation so this aborts and never sends a late playback_done.
    void this.waitUntilPlaybackComplete(gen).then((ok) => {
      if (!ok || gen !== this.generation || !this.flushRequested) return;
      if (
        this.drainingAudio ||
        this.drainingText ||
        this.audioQueue.length > 0 ||
        this.textQueue.length > 0
      ) {
        return;
      }
      this.flushRequested = false;
      // Hold captions past playback_done — STT often finalizes the last words late
      this.scheduleSpokenClear();
      this.onDone?.();
    });
  }

  /**
   * True when local engines report audio finished.
   * Abortable via generation bump on barge `stop()`.
   */
  private waitUntilPlaybackComplete(gen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tick = () => {
        if (gen !== this.generation) {
          resolve(false);
          return;
        }
        const synthBusy =
          typeof window !== "undefined" &&
          (window.speechSynthesis.speaking || window.speechSynthesis.pending);
        if (this.aec.isPlaying() || synthBusy) {
          window.setTimeout(tick, 50);
          return;
        }
        // One quiet sample so we don't race the last buffer callback
        window.setTimeout(() => {
          if (gen !== this.generation) {
            resolve(false);
            return;
          }
          const stillSynth =
            typeof window !== "undefined" &&
            (window.speechSynthesis.speaking || window.speechSynthesis.pending);
          resolve(!this.aec.isPlaying() && !stillSynth);
        }, 80);
      };
      tick();
    });
  }

  private async drainAudio(gen: number): Promise<void> {
    this.drainingAudio = true;
    while (this.audioQueue.length > 0 && gen === this.generation) {
      const url = this.audioQueue.shift()!;
      try {
        await this.aec.playUrl(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[playback] AEC play failed (${message}) — direct fallback`);
        await this.playUrlDirect(url, gen);
      }
      URL.revokeObjectURL(url);
    }
    this.drainingAudio = false;
    this.maybeDone(gen);
  }

  private async drainText(gen: number): Promise<void> {
    this.drainingText = true;
    while (this.textQueue.length > 0 && gen === this.generation) {
      const line = this.textQueue.shift()!;
      if (this.browserTtsEngine === "kokoro") {
        await this.speakKokoroLine(line, gen);
      } else {
        await this.speakLine(line, gen);
      }
    }
    this.drainingText = false;
    this.maybeDone(gen);
  }

  private async speakKokoroLine(text: string, gen: number): Promise<void> {
    if (gen !== this.generation) return;
    try {
      const url = await synthesizeKokoroUrl(text, {
        voice: this.kokoroVoice,
        speed: this.speechRate,
      });
      if (gen !== this.generation) {
        URL.revokeObjectURL(url);
        return;
      }
      this.drainingAudio = true;
      try {
        await this.aec.playUrl(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[playback] AEC play failed (${message}) — direct fallback`);
        await this.playUrlDirect(url, gen);
      }
      URL.revokeObjectURL(url);
      this.drainingAudio = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.kokoroFailNotified) {
        this.kokoroFailNotified = true;
        console.warn(
          `Kokoro TTS failed (${message}) — falling back to system voice`,
        );
      }
      await this.speakLine(text, gen);
    }
  }

  private speakLine(text: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.generation || typeof window === "undefined") {
        resolve();
        return;
      }
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = this.speechRate;
      if (this.voiceURI) {
        const voice = window.speechSynthesis
          .getVoices()
          .find((v) => v.voiceURI === this.voiceURI);
        if (voice) utter.voice = voice;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearInterval(poll);
        resolve();
      };

      const finishWhenQuiet = () => {
        if (gen !== this.generation) {
          finish();
          return;
        }
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.setTimeout(finishWhenQuiet, 80);
          return;
        }
        // Settle after last utterance — onend often fires before audio is fully gone
        window.setTimeout(finish, 280);
      };

      utter.onend = () => finishWhenQuiet();
      utter.onerror = () => finish();
      window.speechSynthesis.speak(utter);

      const maxMs = Math.min(
        30_000,
        Math.max(2_000, text.split(/\s+/).filter(Boolean).length * 220 + 800),
      );
      window.setTimeout(() => {
        if (!settled) finishWhenQuiet();
      }, maxMs);

      const poll = window.setInterval(() => {
        if (gen !== this.generation) {
          window.speechSynthesis.cancel();
          finish();
        }
      }, 50);
    });
  }

  /** Fallback when WebRTC AEC sink fails — no acoustic cancellation. */
  private playUrlDirect(url: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.generation) {
        resolve();
        return;
      }
      this.stopDirectAudio();
      const audio = new Audio(url);
      audio.volume = 1;
      this.directAudio = audio;
      let poll: number | undefined;
      const finish = () => {
        if (poll != null) window.clearInterval(poll);
        if (this.directAudio === audio) this.directAudio = null;
        resolve();
      };
      audio.onended = () => finish();
      audio.onerror = () => finish();
      void audio.play().catch(() => finish());

      poll = window.setInterval(() => {
        if (gen !== this.generation) {
          try {
            audio.pause();
          } catch {
            // ignore
          }
          finish();
        }
      }, 50);
    });
  }
}
