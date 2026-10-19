/**
 * Barge fade policy (ADR-006): cut audio with a short gain ramp, not a cliff.
 * Pure module: numbers in, numbers out. No DOM, no AudioContext. The browser
 * consumes the result (Web Audio AudioParam ramp in webrtc-aec-playback).
 */

export type PlaybackStopReason =
  | "barge_in" // user interrupted while speaking: ramp, don't clip
  | "soft_release" // false candidate cleared; duck/resume handled elsewhere
  | "session_end"; // teardown while audible: same courtesy as barge

/** Module default; override via BARGE_FADE_MS (NEXT_PUBLIC_ prefix for Next). */
export const DEFAULT_BARGE_FADE_MS = 150;

/** Reasons whose fade length IS the barge fade (the rest are 0). */
const FADES_ON_STOP = new Set<PlaybackStopReason>(["barge_in", "session_end"]);

/**
 * Runtime override: NEXT_PUBLIC_BARGE_FADE_MS, then BARGE_FADE_MS. Next.js
 * only inlines NEXT_PUBLIC_* into client bundles; the unprefixed name still
 * works server-side/tests. Bad values fall back to the default.
 */
export function bargeFadeMsFromEnv(
  env?: Record<string, string | undefined>,
): number {
  const source =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
  const raw = source?.NEXT_PUBLIC_BARGE_FADE_MS ?? source?.BARGE_FADE_MS;
  if (raw == null || raw === "") return DEFAULT_BARGE_FADE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BARGE_FADE_MS;
}

/** Fade length for stopping playback for `reason` (0 = hard cut). */
export function fadeMsFor(
  reason: PlaybackStopReason = "barge_in",
  bargeFadeMs: number = bargeFadeMsFromEnv(),
): number {
  if (!Number.isFinite(bargeFadeMs) || bargeFadeMs < 0) return 0;
  return FADES_ON_STOP.has(reason) ? Math.round(bargeFadeMs) : 0;
}
