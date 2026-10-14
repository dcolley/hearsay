import { Agent } from "@mastra/core/agent";
import { sparkModel } from "../lib/model.ts";
import { weatherTool } from "../tools/weather-tool.ts";

export const weatherAgent = new Agent({
  id: "weather-agent",
  name: "Weather Agent",
  instructions: `
      You are a helpful weather assistant that provides accurate weather information.

      Your primary function is to help users get weather details for specific locations. When responding:
      - Include relevant details like humidity, wind conditions, and precipitation
      - Keep responses concise but informative

      Use the weatherTool to fetch current weather data.
`,
  model: sparkModel(),
  tools: { weatherTool },
});
