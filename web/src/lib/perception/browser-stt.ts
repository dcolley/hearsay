/**
 * Browser SpeechRecognition STT (Chrome / Edge / Safari).
 * Used when the perception server has ASR_MODE=browser (no whisper sidecar).
 */

export type BrowserSttHandlers = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (error: string) => void;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionLike)
  | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserSttSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export class BrowserStt {
  private rec: SpeechRecognitionLike | null = null;
  private wanted = false;
  private paused = false;
  private readonly handlers: BrowserSttHandlers;

  constructor(handlers: BrowserSttHandlers = {}) {
    this.handlers = handlers;
  }

  start(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.handlers.onError?.(
        "Browser STT unavailable — use Chrome/Edge, or set ASR_MODE=http with a whisper sidecar",
      );
      return;
    }
    this.wanted = true;
    this.paused = false;
    if (this.rec) return;

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";

    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const piece = ev.results[i]!;
        const text = piece[0]?.transcript?.trim() ?? "";
        if (!text) continue;
        if (piece.isFinal) {
          this.handlers.onFinal?.(text);
        } else {
          interim = interim ? `${interim} ${text}` : text;
        }
      }
      if (interim) this.handlers.onPartial?.(interim);
    };

    rec.onerror = (ev) => {
      // Transient / normal Web Speech errors — never red-banner these
      if (
        ev.error === "no-speech" ||
        ev.error === "aborted" ||
        ev.error === "network" ||
        ev.error === "audio-capture"
      ) {
        return;
      }
      if (ev.error === "not-allowed") {
        this.handlers.onError?.(
          "Microphone permission denied for browser STT",
        );
      }
    };

    rec.onend = () => {
      this.rec = null;
      if (this.wanted && !this.paused) {
        // Chrome stops after a pause — restart while session is live
        window.setTimeout(() => {
          if (this.wanted && !this.paused) this.start();
        }, 200);
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      // Already started
    }
  }

  /** Pause while assistant speaks (half-duplex / avoid TTS echo). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      try {
        this.rec?.stop();
      } catch {
        // ignore
      }
      this.rec = null;
    } else if (this.wanted) {
      this.start();
    }
  }

  stop(): void {
    this.wanted = false;
    this.paused = false;
    try {
      this.rec?.abort();
    } catch {
      // ignore
    }
    this.rec = null;
  }
}
