const STORAGE_KEY = "hearsay.presence.settings";

export type BrowserTtsEngine = "speechSynthesis" | "kokoro";

export type PresenceSettings = {
  wsUrl: string;
  voiceURI: string;
  speechRate: number;
  browserTtsEngine: BrowserTtsEngine;
  kokoroVoice: string;
  autoStartVideo: boolean;
};

const DEFAULT_WS =
  process.env.NEXT_PUBLIC_PERCEPTION_WS_URL || "ws://localhost:4112";

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = {
  wsUrl: DEFAULT_WS,
  voiceURI: "",
  speechRate: 1,
  browserTtsEngine: "speechSynthesis",
  kokoroVoice: "af_heart",
  autoStartVideo: false,
};

export function loadPresenceSettings(): PresenceSettings {
  if (typeof window === "undefined") return { ...DEFAULT_PRESENCE_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PRESENCE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PresenceSettings>;
    const engine =
      parsed.browserTtsEngine === "kokoro" ? "kokoro" : "speechSynthesis";
    return {
      ...DEFAULT_PRESENCE_SETTINGS,
      ...parsed,
      wsUrl: parsed.wsUrl?.trim() || DEFAULT_PRESENCE_SETTINGS.wsUrl,
      speechRate: clampRate(parsed.speechRate ?? 1),
      browserTtsEngine: engine,
      kokoroVoice:
        parsed.kokoroVoice?.trim() || DEFAULT_PRESENCE_SETTINGS.kokoroVoice,
    };
  } catch {
    return { ...DEFAULT_PRESENCE_SETTINGS };
  }
}

export function savePresenceSettings(settings: PresenceSettings): void {
  if (typeof window === "undefined") return;
  const next: PresenceSettings = {
    ...settings,
    wsUrl: settings.wsUrl.trim() || DEFAULT_PRESENCE_SETTINGS.wsUrl,
    speechRate: clampRate(settings.speechRate),
    browserTtsEngine:
      settings.browserTtsEngine === "kokoro" ? "kokoro" : "speechSynthesis",
    kokoroVoice:
      settings.kokoroVoice.trim() || DEFAULT_PRESENCE_SETTINGS.kokoroVoice,
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function clampRate(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.5, Math.max(0.7, n));
}

/** Prefer clearer English system voices when none selected. */
export function pickDefaultVoice(
  voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const en = voices.filter(
    (v) => /^en(-|_)/i.test(v.lang) || /^en$/i.test(v.lang),
  );
  const pool = en.length ? en : voices;
  const scored = [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a));
  return scored[0] ?? null;
}

function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  let s = 0;
  if (v.localService) s += 2;
  if (
    /premium|enhanced|neural|natural|google|samantha|daniel|karen|moira|ava|zoe/.test(
      name,
    )
  ) {
    s += 5;
  }
  if (/compact|eloquence/.test(name)) s -= 3;
  if (/en-us|en_us|en-gb|en_gb/.test(v.lang.toLowerCase())) s += 1;
  return s;
}

export function listSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices();
}
