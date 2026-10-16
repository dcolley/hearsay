/**
 * Narration memory guard (ADR-003 memory hygiene).
 *
 * Progress speech is spoken *outside* the model stream, so narration lines
 * should never reach conversation memory. This is the belt-and-braces guard
 * for the two ways they could leak in anyway:
 *
 *   1. A model echo — the assistant repeats "Let me check." as part of its
 *      answer (mimicry of what it heard, or a leaked prompt artifact).
 *   2. A future feature that injects narration into the stream.
 *
 * The filter strips *exact whole sentences* that match a known narration
 * line from assistant messages before they persist (see
 * `HearsayMemory.saveMessages`). Substrings inside longer sentences are never
 * touched: "You are still working on it?" is the model's own text, not
 * narration.
 *
 * Catchphrase fatigue (the reason jarvis-desk-bot dedupes variants) lives on
 * the narration side instead: still-lines already rotate through three
 * variants, so the model — and the user — never hear one every turn.
 */

import type { MastraDBMessage } from "@mastra/core/agent";
import { narrationSentences } from "./progress.ts";
import { toolFillerPhrases } from "./tool-fillers.ts";

const NARRATION = new Set(
  [...narrationSentences(), ...toolFillerPhrases()].map(normalize),
);

function normalize(sentence: string): string {
  return sentence
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[.!]+$/, "");
}

/** True when `sentence` is exactly a narration line (case/punctuation-insensitive). */
export function isNarratedSentence(sentence: string): boolean {
  return NARRATION.has(normalize(sentence));
}

/**
 * Remove narration-matching sentences from `text`. Splits on sentence-final
 * punctuation only, so mid-sentence uses of the same words survive. Returns
 * the original unchanged when nothing matches; "" when the text was entirely
 * narration.
 */
export function stripNarrationFromText(text: string): string {
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !isNarratedSentence(s));
  if (kept.length === sentences.length) return text;
  if (kept.length === 0) return "";
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

type ContentPart = { type: string; text?: string } & Record<string, unknown>;

/**
 * Strip narration from one persisted message. Only assistant messages are
 * touched; a message that is *pure* narration echo is left intact rather than
 * persisting an empty hole in the thread.
 */
export function stripNarrationFromMessage(
  message: MastraDBMessage,
): MastraDBMessage {
  if ((message as { role?: string }).role !== "assistant") return message;

  const content = (message as { content?: unknown }).content;
  if (!content || typeof content === "string") return message; // v2 shape is an object; be tolerant

  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return message;

  let changed = false;
  const keptParts: ContentPart[] = [];
  for (const part of parts as ContentPart[]) {
    if (part?.type === "text" && typeof part.text === "string") {
      const stripped = stripNarrationFromText(part.text);
      if (stripped === "") {
        changed = true; // text part was pure narration echo — drop it
        continue;
      }
      if (stripped !== part.text) {
        changed = true;
        keptParts.push({ ...part, text: stripped });
        continue;
      }
    }
    keptParts.push(part);
  }

  if (!changed) return message;
  if (keptParts.length === 0) return message; // pure echo: keep original, never store empty

  const textContent = keptParts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ")
    .trim();

  return {
    ...message,
    content: {
      ...(content as Record<string, unknown>),
      parts: keptParts,
      content: textContent,
    },
  } as MastraDBMessage;
}
