import { Mastra } from "@mastra/core";
import { registerCopilotKit } from "@ag-ui/mastra/copilotkit";
import { hearsayAgent } from "./agents/hearsay-agent.ts";
import { weatherAgent } from "./agents/weather-agent.ts";
import {
  createHearsayStorage,
  hearsayResourceId,
} from "./memory/hearsay-memory.ts";

// Shared LibSQL store (same singleton used by hearsayAgent memory)
const storage = createHearsayStorage();

export const mastra = new Mastra({
  agents: { hearsayAgent, weatherAgent },
  storage,
  server: {
    cors: {
      origin: [
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["*"],
    },
    apiRoutes: [
      registerCopilotKit({
        path: "/copilotkit",
        resourceId: hearsayResourceId,
      }),
    ],
  },
});
