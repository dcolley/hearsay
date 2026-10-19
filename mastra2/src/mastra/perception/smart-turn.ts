/**
 * Smart Turn v3 semantic end-of-turn classifier.
 *
 * Wraps smart-turn-v3.2-cpu.onnx (onnxruntime-node) in the session's turn
 * gate. Feed the last 8 s of utterance PCM (float32 mono, 16 kHz) and get a
 * committed / in-progress verdict back.
 *
 * The session path is Promise-chained (non-reentrant) exactly like
 * silero-vad.ts: onnxruntime sessions serialize execution, and the mel
 * builder is state-free but allocates, so keep one instance per session.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeWhisperMel } from "./whisper-mel.ts";

export interface TurnClassifier {
  /**
   * True when the utterance is semantically complete (committed), false when
   * still in progress, and null when unavailable (model missing, load or
   * inference failed) so callers can fall back to silence-based endpointing.
   */
  isEndOfTurn(pcmFloat32: Float32Array): Promise<boolean | null>;
}

/** Default model location filled by `yarn models`. */
export function defaultModelPath(): string {
  return (
    process.env.SMART_TURN_MODEL_PATH ||
    join(homedir(), ".cache", "hearsay", "smart-turn-v3.2-cpu.onnx")
  );
}

/** Model probability threshold above which the turn is considered ended. */
export function smartTurnThreshold(): number {
  const raw = Number(process.env.SMART_TURN_THRESHOLD);
  return Number.isFinite(raw) ? raw : 0.5;
}

export class SmartTurnClassifier implements TurnClassifier {
  private constructor(
    private readonly session: import("onnxruntime-node").InferenceSession,
    private readonly threshold: number,
  ) {}

  /**
   * Load the ONNX model; returns null when the file is absent or the session
   * cannot be created (a null classifier must fall back to adaptive silence,
   * never crash the server).
   */
  static async create(modelPath = defaultModelPath()): Promise<SmartTurnClassifier | null> {
    if (!existsSync(modelPath)) return null;
    try {
      const ort = await import("onnxruntime-node");
      const session = await ort.InferenceSession.create(modelPath);
      return new SmartTurnClassifier(session, smartTurnThreshold());
    } catch {
      return null;
    }
  }

  private chain: Promise<unknown> = Promise.resolve();

  /** One inference per call, serialized onto the model session. */
  private infer(pcmFloat32: Float32Array): Promise<number> {
    const run = async (): Promise<number> => {
      const ort = await import("onnxruntime-node");
      const features = computeWhisperMel(pcmFloat32);
      const tensor = new ort.Tensor("float32", features, [1, 80, 800]);
      const out = await this.session.run({ input_features: tensor });
      const logits = out["logits"] as { data: ArrayLike<number> } | undefined;
      if (!logits) throw new Error("smart-turn: missing logits output");
      return Number(logits.data[0]);
    };
    const next = this.chain.then(run, run);
    // Keep the chain alive regardless of failure.
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  async isEndOfTurn(pcmFloat32: Float32Array): Promise<boolean | null> {
    try {
      const prob = await this.infer(pcmFloat32);
      return prob >= this.threshold;
    } catch {
      return null;
    }
  }
}
