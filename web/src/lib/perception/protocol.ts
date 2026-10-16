export type AgentState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "awaiting_user";

export type ConversationTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ServerHelloInfo = {
  threadId: string;
  resourceId: string;
  halfDuplex: boolean;
  bargeInEnabled: boolean;
  asrMode: string;
  ttsMode: string;
  vadMode: string;
  listenArmMs: number;
  sustainMs: number;
  visionEnabled: boolean;
};

export type ServerMessage =
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
  | ({
      type: "hello_ack";
      t_ms: number;
    } & ServerHelloInfo)
  | {
      type: "conversation_history";
      t_ms: number;
      messages: ConversationTurn[];
    }
  | {
      type: "session_cleared";
      t_ms: number;
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

export function encodePcmFrame(t_ms: number, samples: Int16Array): ArrayBuffer {
  const out = new ArrayBuffer(PCM_HEADER_BYTES + samples.byteLength);
  const view = new DataView(out);
  view.setBigUint64(0, BigInt(Math.max(0, Math.floor(t_ms))), true);
  // ArrayBuffer is always offset-0 aligned; 8 is a valid Int16 start.
  new Int16Array(out, PCM_HEADER_BYTES).set(samples);
  return out;
}
