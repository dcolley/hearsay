import { WebSocketServer, type WebSocket } from "ws";
import type { PerceptionSession } from "./session.ts";
import {
  parsePcmBinary,
  type ClientControlMessage,
  type ServerControlMessage,
} from "./types.ts";

export type PerceptionWsOptions = {
  port: number;
  createSession: () => PerceptionSession | Promise<PerceptionSession>;
  halfDuplex: boolean;
  bargeInEnabled?: boolean;
  asrMode?: string;
  ttsMode?: string;
  vadMode?: string;
  listenArmMs?: number;
  sustainMs?: number;
  visionEnabled?: boolean;
};

function helloAck(
  opts: PerceptionWsOptions,
  session: PerceptionSession,
): ServerControlMessage {
  return {
    type: "hello_ack",
    t_ms: Date.now(),
    halfDuplex: opts.halfDuplex,
    bargeInEnabled: opts.bargeInEnabled ?? false,
    asrMode: opts.asrMode ?? "http",
    ttsMode: opts.ttsMode ?? process.env.TTS_MODE ?? "http",
    vadMode: opts.vadMode ?? process.env.VAD_MODE ?? "silero",
    listenArmMs: opts.listenArmMs ?? Number(process.env.LISTEN_ARM_MS || 700),
    sustainMs:
      opts.sustainMs ?? Number(process.env.BARGE_IN_SUSTAIN_MS || 180),
    visionEnabled: opts.visionEnabled ?? false,
    threadId: session.threadId,
    resourceId: session.resourceId,
  };
}

function sendJson(ws: WebSocket, msg: ServerControlMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function wireSession(ws: WebSocket, session: PerceptionSession): () => void {
  session.setClientActionSender((req) => {
    sendJson(ws, {
      type: "client.action",
      t_ms: Date.now(),
      id: req.id,
      tool: req.tool,
      args: req.args,
    });
  });

  const unsubs = [
    session.bus.on("state", ({ state }) => {
      sendJson(ws, { type: "state", t_ms: Date.now(), state });
    }),
    session.bus.on("end_of_turn", ({ text, t_ms }) => {
      sendJson(ws, { type: "transcript", t_ms, text });
    }),
    session.bus.on("partial", ({ text }) => {
      sendJson(ws, { type: "partial", t_ms: Date.now(), text });
    }),
    session.bus.on("tts_chunk", (chunk) => {
      if (chunk.audio && chunk.audio.length > 0) {
        sendJson(ws, {
          type: "tts_audio",
          t_ms: Date.now(),
          mime: chunk.mime ?? "audio/mpeg",
          base64: chunk.audio.toString("base64"),
          text: chunk.text,
        });
      } else if (chunk.text) {
        sendJson(ws, { type: "tts_text", t_ms: Date.now(), text: chunk.text });
      }
    }),
    session.bus.on("tts_end", ({ t_ms }) => {
      sendJson(ws, { type: "tts_end", t_ms });
    }),
    session.bus.on("tts_flush", ({ t_ms }) => {
      sendJson(ws, { type: "tts_flush", t_ms });
    }),
    session.bus.on("listen_arm", ({ t_ms, armed, until_ms }) => {
      sendJson(ws, { type: "listen_arm", t_ms, armed, until_ms });
    }),
    session.bus.on("barge_in", ({ t_ms }) => {
      sendJson(ws, { type: "barge_in", t_ms });
    }),
    session.bus.on("barge_soft_pause", ({ t_ms }) => {
      sendJson(ws, { type: "barge_soft_pause", t_ms });
    }),
    session.bus.on("barge_resume", ({ t_ms }) => {
      sendJson(ws, { type: "barge_resume", t_ms });
    }),
    session.bus.on("error", ({ error }) => {
      sendJson(ws, { type: "error", t_ms: Date.now(), error });
    }),
  ];

  return () => {
    for (const u of unsubs) u();
    session.setClientActionSender(null);
  };
}

export function startPerceptionWsServer(
  opts: PerceptionWsOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ port: opts.port });
  console.log(`[perception] WebSocket listening on ws://127.0.0.1:${opts.port}`);

  wss.on("connection", (ws) => {
    let session: PerceptionSession | null = null;
    let unwire: (() => void) | null = null;
    let audioInFlight = false;
    let closed = false;

    void (async () => {
      try {
        session = await Promise.resolve(opts.createSession());
        if (closed) {
          session.reset();
          return;
        }
        unwire = wireSession(ws, session);
        sendJson(ws, helloAck(opts, session));
        sendJson(ws, {
          type: "state",
          t_ms: Date.now(),
          state: session.getState(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(ws, { type: "error", t_ms: Date.now(), error: message });
        ws.close();
      }
    })();

    ws.on("message", (data, isBinary) => {
      if (!session) return;
      try {
        if (isBinary) {
          if (audioInFlight) return;
          const buf = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          const frame = parsePcmBinary(buf);
          if (!frame) return;
          audioInFlight = true;
          void session
            .onAudio(frame)
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              sendJson(ws, { type: "error", t_ms: Date.now(), error: message });
            })
            .finally(() => {
              audioInFlight = false;
            });
          return;
        }

        const raw = typeof data === "string" ? data : data.toString("utf8");
        const msg = JSON.parse(raw) as ClientControlMessage;

        switch (msg.type) {
          case "hello":
            sendJson(ws, helloAck(opts, session));
            break;
          case "ping":
            sendJson(ws, { type: "pong", t_ms: msg.t_ms });
            break;
          case "speech_start":
            session.onSpeechStart(msg.t_ms);
            break;
          case "barge_in":
            session.onBargeInRequest(msg.t_ms);
            break;
          case "playback_done":
            session.onPlaybackDone(msg.t_ms);
            break;
          case "text_utterance":
            session.onTextUtterance(msg.text, msg.t_ms);
            break;
          case "frame":
            void session.onFrame({
              t_ms: msg.t_ms,
              dataUrl: msg.dataUrl,
              width: msg.width,
              height: msg.height,
              description: msg.description,
            });
            break;
          case "tool_result":
            session.onToolResult({
              id: msg.id,
              ok: msg.ok,
              result: msg.result,
              error: msg.error,
            });
            break;
          default:
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(ws, { type: "error", t_ms: Date.now(), error: message });
      }
    });

    ws.on("close", () => {
      closed = true;
      unwire?.();
      session?.reset();
    });

    ws.on("error", (err) => {
      console.error("[perception] ws error:", err);
    });
  });

  return wss;
}
