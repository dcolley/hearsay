import type { PcmFrame } from "./types.ts";

export interface VadResult {
  isSpeech: boolean;
  /** RMS (energy) or Silero speech probability */
  energy: number;
}

export interface VadAdapter {
  process(frame: PcmFrame): VadResult | Promise<VadResult>;
  reset(): void;
}

/** Cheap RMS energy gate — fallback when Silero is unavailable. */
export class EnergyVad implements VadAdapter {
  private readonly threshold: number;
  private readonly hangoverFrames: number;
  private hangover = 0;
  private speaking = false;

  constructor(opts?: { threshold?: number; hangoverMs?: number }) {
    this.threshold =
      opts?.threshold ??
      Number(process.env.VAD_ENERGY_THRESHOLD || 0.02);
    const hangoverMs = opts?.hangoverMs ?? 300;
    this.hangoverFrames = Math.max(1, Math.round(hangoverMs / 20));
  }

  process(frame: PcmFrame): VadResult {
    let sum = 0;
    for (let i = 0; i < frame.samples.length; i++) {
      const n = frame.samples[i]! / 32768;
      sum += n * n;
    }
    const energy = Math.sqrt(sum / Math.max(1, frame.samples.length));
    const above = energy >= this.threshold;

    if (above) {
      this.hangover = this.hangoverFrames;
      this.speaking = true;
    } else if (this.hangover > 0) {
      this.hangover -= 1;
      this.speaking = true;
    } else {
      this.speaking = false;
    }

    return { isSpeech: this.speaking, energy };
  }

  reset(): void {
    this.hangover = 0;
    this.speaking = false;
  }
}

export async function createVadAdapter(): Promise<VadAdapter> {
  const mode = (process.env.VAD_MODE || "silero").toLowerCase();
  if (mode === "energy") {
    return new EnergyVad();
  }

  try {
    const { SileroVad } = await import("./silero-vad.ts");
    const vad = await SileroVad.create();
    console.log("[vad] mode=silero (avr-vad / Silero v5)");
    return vad;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[vad] Silero init failed (${message}) — falling back to energy`);
    return new EnergyVad();
  }
}

/** Continuous isSpeech for ≥ sustainMs (default 180). Shared by listen + barge-in. */
export class SustainedSpeechGate {
  private readonly needFrames: number;
  private run = 0;

  constructor(sustainMs = Number(process.env.BARGE_IN_SUSTAIN_MS || 180)) {
    this.needFrames = Math.max(1, Math.ceil(sustainMs / 20));
  }

  /** Feed one VAD frame; returns true once sustain threshold is met. */
  feed(isSpeech: boolean): boolean {
    if (!isSpeech) {
      this.run = 0;
      return false;
    }
    this.run += 1;
    return this.run >= this.needFrames;
  }

  reset(): void {
    this.run = 0;
  }
}
