/**
 * Text echo filter for speaker bleed (TTS → mic → STT).
 * Engine-agnostic: compares STT transcript against the spoken TTS caption buffer.
 * Mild defaults aligned with iOS isLikelyEcho (overlapFloor 0.75).
 */

export type EchoFilterOpts = {
  /** Fraction of spoken-transcript words that must overlap TTS (0–1). */
  overlapFloor?: number;
};

export function normalizeForCompare(text: string): string {
  const apostrophes = /['‘’‚‛′‵´ʹʼˈ`]/g;
  const stripped = text.toLowerCase().replace(apostrophes, "");
  const words = stripped
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .flatMap((w, i, arr) => {
      // Merge dangling contraction tails: "that" + "s" → "thats"
      const tails = new Set(["s", "t", "ll", "re", "ve", "d", "m"]);
      if (i > 0 && tails.has(w) && arr[i - 1]!.length >= 2) {
        return [];
      }
      const next = arr[i + 1];
      if (next && tails.has(next) && w.length >= 2) {
        return [w + next];
      }
      return [w];
    });
  return words.join(" ");
}

/**
 * True when `transcript` looks like a re-hearing of `spokenTts`
 * (substring / prefix / word-set overlap / tail overlap).
 */
export function isLikelyEcho(
  transcript: string,
  spokenTts: string,
  opts?: EchoFilterOpts,
): boolean {
  const overlapFloor = opts?.overlapFloor ?? 0.75;
  const spoken = normalizeForCompare(transcript);
  const assistant = normalizeForCompare(spokenTts);
  if (!spoken) return true;
  if (!assistant) return false;

  if (assistant.includes(spoken) || assistant.startsWith(spoken)) return true;

  const spokenWords = spoken.split(" ").filter(Boolean);
  const assistantWords = assistant.split(" ").filter(Boolean);
  if (spokenWords.length === 0) return true;

  const spokenSet = new Set(spokenWords);
  const assistantSet = new Set(assistantWords);

  // Short bleed (1–3 words) that all appear in TTS — common with speaker STT
  if (
    spokenWords.length <= 3 &&
    spokenWords.every((w) => assistantSet.has(w))
  ) {
    return true;
  }

  const fullOverlap =
    spokenSet.size === 0
      ? 0
      : [...spokenSet].filter((w) => assistantSet.has(w)).length /
        spokenSet.size;
  if (fullOverlap >= overlapFloor) return true;

  const tail = new Set(assistantWords.slice(-15));
  const tailOverlap =
    spokenSet.size === 0
      ? 0
      : [...spokenSet].filter((w) => tail.has(w)).length / spokenSet.size;
  if (tailOverlap >= overlapFloor) return true;

  // Last-3 phrase: if the last few spoken words appear as a contiguous run in TTS
  if (spokenWords.length >= 2) {
    const tip = spokenWords.slice(-3).join(" ");
    if (tip && assistant.includes(tip)) return true;
  }

  return false;
}
