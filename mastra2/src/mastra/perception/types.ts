export type AgentState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  /** Agent paused on ask_user / offer_choices — mic should stay live. */
  | "awaiting_user";

export interface SceneMemory {
  at: number;
  people: string;
  objects_changed: string[];
  readouts: string[];
  confidence: number;
}

export function emptyScene(): SceneMemory {
  return {
    at: 0,
    people: "",
    objects_changed: [],
    readouts: [],
    confidence: 0,
  };
}

export function formatScene(scene: SceneMemory): string {
  if (!scene.at) return "(no visual update yet)";
  const parts = [
    scene.people,
    ...scene.objects_changed,
    ...scene.readouts,
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "(scene empty)";
}

/** Client → server JSON control messages */
export type ClientControlMessage =
  | { type: "hello"; t_ms: number; sampleRate?: number }
  | { type: "speech_start"; t_ms: number }
  | { type: "barge_in"; t_ms: number }
  | { type: "text_utterance"; t_ms: number; text: string }
  | {
      type: "frame";
      t_ms: number;
      dataUrl: string;
      width?: number;
      height?: number;
      description?: string;
    }
  | {
      type: "tool_result";
      t_ms: number;
      id: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | { type: "playback_done"; t_ms: number }
  | { type: "ping"; t_ms: number };

/** Server → client JSON messages */
export type ServerControlMessage =
  | { type: "state"; t_ms: number; state: AgentState }
  | { type: "partial"; t_ms: number; text: string }
  | { type: "transcript"; t_ms: number; text: string }
  | { type: "tts_text"; t_ms: number; text: string }
  | {
      type: "tts_audio";
      t_ms: number;
      mime: string;
      base64: string;
      text?: string;
    }
  | { type: "tts_end"; t_ms: number }
  /** Client should drain queues then send playback_done. */
  | { type: "tts_flush"; t_ms: number }
  | {
      type: "listen_arm";
      t_ms: number;
      armed: boolean;
      until_ms: number;
    }
  | { type: "barge_in"; t_ms: number }
  | { type: "barge_soft_pause"; t_ms: number }
  | { type: "barge_resume"; t_ms: number }
  | { type: "error"; t_ms: number; error: string }
  | { type: "pong"; t_ms: number }
  | {
      type: "hello_ack";
      t_ms: number;
      halfDuplex: boolean;
      bargeInEnabled: boolean;
      asrMode: string;
      ttsMode: string;
      vadMode: string;
      listenArmMs: number;
      sustainMs: number;
      visionEnabled: boolean;
      threadId: string;
      resourceId: string;
    }
  | {
      type: "client.action";
      t_ms: number;
      id: string;
      tool:
        | "ask_user"
        | "offer_choices"
        | "request_camera_frame"
        | "capture_screenshot";
      args: Record<string, unknown>;
    };

export const PCM_HEADER_BYTES = 8;
export const PCM_SAMPLE_RATE = 16_000;
export const PCM_FRAME_SAMPLES = 320; // 20 ms @ 16 kHz

export interface PcmFrame {
  t_ms: number;
  samples: Int16Array;
}

export function parsePcmBinary(buf: Buffer): PcmFrame | null {
  if (buf.byteLength < PCM_HEADER_BYTES + 2) return null;
  const t_ms = Number(buf.readBigUInt64LE(0));
  const sampleBytes = buf.byteLength - PCM_HEADER_BYTES;
  if (sampleBytes % 2 !== 0) return null;
  // Copy into an aligned buffer — WS Buffers often have odd byteOffset, and
  // Int16Array requires byteOffset % 2 === 0.
  const aligned = Buffer.allocUnsafe(sampleBytes);
  buf.copy(aligned, 0, PCM_HEADER_BYTES, PCM_HEADER_BYTES + sampleBytes);
  const samples = new Int16Array(
    aligned.buffer,
    aligned.byteOffset,
    sampleBytes / 2,
  );
  return { t_ms, samples };
}

export function encodePcmBinary(t_ms: number, samples: Int16Array): Buffer {
  const out = Buffer.alloc(PCM_HEADER_BYTES + samples.byteLength);
  out.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(t_ms))), 0);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(
    out,
    PCM_HEADER_BYTES,
  );
  return out;
}
