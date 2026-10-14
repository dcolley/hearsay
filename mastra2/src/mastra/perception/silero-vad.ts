import { RealTimeVAD } from "avr-vad";
import type { PcmFrame } from "./types.ts";
import type { VadAdapter, VadResult } from "./vad.ts";

function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i]! / 32768;
  }
  return out;
}

/**
 * Silero VAD via avr-vad (ONNX Runtime Node, v5 model, 512-sample frames).
 * Buffers 20 ms client frames internally.
 */
export class SileroVad implements VadAdapter {
  private rt: RealTimeVAD | null = null;
  private last: VadResult = { isSpeech: false, energy: 0 };
  private ready: Promise<void>;
  private processChain: Promise<void> = Promise.resolve();
  private positiveThreshold: number;

  private constructor() {
    this.positiveThreshold = Number(process.env.VAD_POSITIVE_THRESHOLD || 0.5);
    this.ready = this.init();
  }

  static async create(): Promise<SileroVad> {
    const vad = new SileroVad();
    await vad.ready;
    return vad;
  }

  private async init(): Promise<void> {
    const positive = this.positiveThreshold;
    const negative = Number(process.env.VAD_NEGATIVE_THRESHOLD || 0.35);

    this.rt = await RealTimeVAD.new({
      model: "v5",
      sampleRate: 16_000,
      positiveSpeechThreshold: positive,
      negativeSpeechThreshold: negative,
      // Session sustain gate owns min-duration policy
      minSpeechFrames: 1,
      onFrameProcessed: (probs) => {
        const p = typeof probs.isSpeech === "number" ? probs.isSpeech : 0;
        this.last = { isSpeech: p >= positive, energy: p };
      },
    });
    this.rt.start();
  }

  async process(frame: PcmFrame): Promise<VadResult> {
    await this.ready;
    const rt = this.rt;
    if (!rt) return this.last;

    const float = int16ToFloat32(frame.samples);
    // Serialize processAudio calls — RealTimeVAD is not re-entrant
    this.processChain = this.processChain.then(() => rt.processAudio(float));
    await this.processChain;
    return this.last;
  }

  reset(): void {
    this.last = { isSpeech: false, energy: 0 };
    this.rt?.reset();
  }

  async destroy(): Promise<void> {
    await this.rt?.destroy();
    this.rt = null;
  }
}
