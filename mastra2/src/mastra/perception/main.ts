import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../../.env") });

const { hearsayAgent, hearsayMemory } = await import("../agents/hearsay-agent.ts");
const { createAsrAdapter, resolveAsrMode } = await import("./asr.ts");
const { createTtsAdapter } = await import("./tts.ts");
const { PerceptionSession } = await import("./session.ts");
const { createTurnDetector } = await import("./turn.ts");
const { createVadAdapter } = await import("./vad.ts");
const { StubVisionAdapter } = await import("./vision.ts");
const { startPerceptionWsServer } = await import("./ws-server.ts");
const { hearsayResourceId } = await import("../memory/hearsay-memory.ts");

const port = Number(process.env.PERCEPTION_WS_PORT || 4112);
const halfDuplex =
  (process.env.HALF_DUPLEX ?? "true").toLowerCase() !== "false";
const bargeInEnabled =
  (process.env.BARGE_IN_ENABLED ?? "false").toLowerCase() === "true";
const asrMode = resolveAsrMode();
const ttsMode = (process.env.TTS_MODE || "http").toLowerCase();
const vadMode = (process.env.VAD_MODE || "silero").toLowerCase();
const turnMode = (process.env.TURN_MODE || "adaptive").toLowerCase();
const listenArmMs = Number(process.env.LISTEN_ARM_MS || 700);
const sustainMs = Number(process.env.BARGE_IN_SUSTAIN_MS || 180);
const effortMs = Number(process.env.BARGE_EFFORT_MS || 300);
const visionEnabled =
  (process.env.VISION_ENABLED ?? "true").toLowerCase() !== "false";
const progressEnabled =
  (process.env.PROGRESS_ENABLED ?? "true").toLowerCase() !== "false";

async function createSession(opts?: { threadId?: string }) {
  return new PerceptionSession({
    agent: hearsayAgent,
    memory: hearsayMemory,
    vad: await createVadAdapter(),
    turn: await createTurnDetector(),
    asr: createAsrAdapter(asrMode),
    tts: createTtsAdapter(),
    vision: new StubVisionAdapter(),
    halfDuplex,
    bargeInEnabled,
    clientOwnsAsr: asrMode === "browser",
    listenArmMs,
    sustainMs,
    resourceId: hearsayResourceId,
    progress: { enabled: progressEnabled },
    threadId: opts?.threadId,
  });
}

startPerceptionWsServer({
  port,
  createSession,
  halfDuplex,
  bargeInEnabled,
  asrMode,
  ttsMode,
  vadMode,
  listenArmMs,
  sustainMs,
  visionEnabled,
});

console.log(
  `[perception] halfDuplex=${halfDuplex} bargeIn=${bargeInEnabled} VAD_MODE=${vadMode} TURN_MODE=${turnMode} ASR_MODE=${asrMode} TTS_MODE=${ttsMode} vision=${visionEnabled}`,
);
console.log(
  `[perception] LISTEN_ARM_MS=${listenArmMs} BARGE_IN_SUSTAIN_MS=${sustainMs} BARGE_EFFORT_MS=${effortMs}`,
);
console.log(
  `[perception] PROGRESS_ENABLED=${progressEnabled} PROGRESS_ACK_MS=${process.env.PROGRESS_ACK_MS || 3000} PROGRESS_STILL_MS=${process.env.PROGRESS_STILL_MS || 20000}`,
);
console.log(
  `[perception] OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL || "(unset)"} MODEL=${process.env.OPENAI_MODEL || "(unset)"} resource=${hearsayResourceId}`,
);
