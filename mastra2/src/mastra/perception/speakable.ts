/**
 * Speakable guard (ADR-004): keep text a browser's English voice can
 * actually say.
 *
 * Local models (Spark via TensorFold) drift into CJK on garbled audio —
 * exactly the failure dreamhunter02/jarvis-desk-bot documents ("GLM sometimes
 * answered in Chinese, which an English voice cannot read"). Their fix was
 * one principled script filter, no phrase-matching guards, plus a polite
 * fallback when nothing speakable survives. This module is that filter.
 *
 * Applied inside `toSpokenReply`, so every spoken path gets it. It only
 * affects the audio route: the transcript/log keeps the model's real output.
 */

/**
 * CJK ideographs, kana, Hangul, CJK punctuation, fullwidth forms.
 * Same ranges as jarvis-desk-bot's provider (proven in production voice).
 */
const UNSPEAKABLE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]+/g;

/** Shown/said when a whole turn collapses to nothing speakable. */
export const NOT_CAUGHT = "Sorry, I didn't catch that.";

/** Strip unreadable scripts; tidy the surrounding whitespace. Never throws. */
export function dropUnreadableScripts(text: string): string {
  return text
    .replace(UNSPEAKABLE, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*[,.!?;:]+\s*/, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** True when `text` contains something an English voice can pronounce. */
export function isSpeakable(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

/** Did the raw text actually contain unspeakable script? (for metrics) */
export function hasUnreadableScript(text: string): boolean {
  return UNSPEAKABLE.test(text);
}
