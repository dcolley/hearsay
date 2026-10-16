/**
 * Heuristic: browser STT finals sometimes commit mid-thought
 * ("What's the weather in"). Not a semantic EOU model — just a short hold.
 */

const INCOMPLETE_TAIL =
  /\b(and|or|but|so|because|if|when|while|that|than|the|a|an|to|in|on|at|of|for|with|from|into|about|my|your|our|is|are|was|were|will|would|can|could|should|what's|whats|who's|whos|where's|wheres|how's|hows)$/i;

/** True when the final looks like it was cut before the user finished. */
export function looksIncompleteUtterance(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Complete if ends with sentence punctuation
  if (/[.!?…]$/.test(t)) return false;
  // Trailing incomplete token / preposition
  const last = t.split(/\s+/).pop() ?? "";
  if (INCOMPLETE_TAIL.test(last)) return true;
  // Ends with a bare conjunction-like fragment after a comma
  if (/,\s*$/.test(t)) return true;
  return false;
}

/** Hold window before committing an incomplete-looking final (ms). */
export const INCOMPLETE_UTTERANCE_HOLD_MS = 700;
