/**
 * Orb mood map (pure) — the presence face.
 *
 * Maps agent state to what the orb looks like. Kept as data + a function so
 * it is testable without React; `voice-orb.tsx` just turns the numbers into
 * CSS. Grok-style life comes from easing and micro-motion, not complexity:
 * slow float always, blink cadence per mood, pupil drift as the "alive" cue.
 */

import type { AgentState } from "./protocol";

export type OrbMood =
  | "sleep"
  | "idle"
  | "alert"
  | "ponder"
  | "talk"
  | "startled"
  | "curious";

export type OrbLook = {
  mood: OrbMood;
  /** Glow intensity 0..1. */
  glow: number;
  /** Orb diameter in px. */
  size: number;
  /** Full blink cycle length in ms. */
  blinkPeriodMs: number;
  /** One blink in ms. */
  blinkDurMs: number;
  /** Float/pulse cycle in ms. */
  pulseMs: number;
  /** Pupil behaviour: the "alive" signal. */
  drift: "none" | "slow" | "track" | "sweep";
  /** Gradient endpoints for the orb face. */
  colorA: string;
  colorB: string;
};

const MOODS: Record<Exclude<AgentState, never> | "off", OrbLook> = {
  off: {
    mood: "sleep", glow: 0.15, size: 88, blinkPeriodMs: 5200, blinkDurMs: 170,
    pulseMs: 6500, drift: "slow", colorA: "#1e1b4b", colorB: "#312e81",
  },
  idle: {
    mood: "idle", glow: 0.45, size: 96, blinkPeriodMs: 4600, blinkDurMs: 150,
    pulseMs: 4800, drift: "slow", colorA: "#4c1d95", colorB: "#7c3aed",
  },
  listening: {
    mood: "alert", glow: 0.8, size: 104, blinkPeriodMs: 6000, blinkDurMs: 120,
    pulseMs: 2600, drift: "track", colorA: "#134e4a", colorB: "#14b8a6",
  },
  thinking: {
    mood: "ponder", glow: 0.55, size: 92, blinkPeriodMs: 3000, blinkDurMs: 260,
    pulseMs: 3600, drift: "sweep", colorA: "#78350f", colorB: "#f59e0b",
  },
  speaking: {
    mood: "talk", glow: 0.95, size: 108, blinkPeriodMs: 4200, blinkDurMs: 130,
    pulseMs: 900, drift: "track", colorA: "#0c4a6e", colorB: "#38bdf8",
  },
  interrupted: {
    mood: "startled", glow: 0.9, size: 110, blinkPeriodMs: 2400, blinkDurMs: 90,
    pulseMs: 700, drift: "none", colorA: "#7f1d1d", colorB: "#f87171",
  },
  awaiting_user: {
    mood: "curious", glow: 0.6, size: 100, blinkPeriodMs: 3400, blinkDurMs: 180,
    pulseMs: 2400, drift: "track", colorA: "#831843", colorB: "#f472b6",
  },
};

export function orbLook(state: AgentState, running: boolean): OrbLook {
  if (!running) return MOODS.off;
  return MOODS[state] ?? MOODS.idle;
}

/** CSS custom properties for the component (numbers as raw strings). */
export function orbVars(look: OrbLook): Record<string, string> {
  return {
    "--orb-size": `${look.size}px`,
    "--orb-glow": `${look.glow}`,
    "--orb-blink-period": `${look.blinkPeriodMs}ms`,
    "--orb-blink-dur": `${look.blinkDurMs}ms`,
    "--orb-pulse": `${look.pulseMs}ms`,
    "--orb-a": look.colorA,
    "--orb-b": look.colorB,
  };
}
