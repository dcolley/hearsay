/**
 * Short spoken latency fillers while a tool runs (LiveKit-style toolFeedback).
 * Tool UI / args are never spoken — only these phrases.
 */

const HITL_TOOLS = new Set(["ask_user", "offer_choices"]);

const FILLERS: Record<string, string> = {
  "get-weather": "Checking the weather.",
  web_search: "Looking that up.",
  capture_screenshot: "Checking the screen.",
  request_camera_frame: "Taking a look.",
  get_date_time: "Checking the time.",
  format_date_time: "One moment.",
  clear_conversation: "Clearing the chat.",
};

/** Spoken filler for a tool id, or null if HITL / unknown / no filler. */
export function toolFillerPhrase(toolName: string | undefined): string | null {
  if (!toolName || HITL_TOOLS.has(toolName)) return null;
  return FILLERS[toolName] ?? null;
}

/** Every distinct filler phrase (for the memory narration-guard). */
export function toolFillerPhrases(): string[] {
  return [...new Set(Object.values(FILLERS))];
}
