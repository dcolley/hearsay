import { createSkill } from "@mastra/core/skills";

/**
 * How to fetch and speak current weather via Open-Meteo.
 */
export const weatherSkill = createSkill({
  name: "weather",
  description:
    "Use when the user asks about weather, temperature, rain, forecast, or conditions for a place.",
  instructions: `
# Weather

## Tool

- \`get_weather\` (tool id \`get-weather\`) — current conditions via Open-Meteo.
  - Required arg \`location\`: city or place name (e.g. "London", "Paris", "New York").
  - Returns: \`location\` (resolved label), \`temperatureCelsius\`, \`conditions\`, \`humidityPercent\`, \`windSpeedKmh\`.

## When to call

1. User asks about weather / temperature / rain / wind / humidity for a place.
2. If they omit the place, use a sensible default only if context is clear; otherwise call \`ask_user\` for the city, then \`get_weather\`.

## How to answer

1. Call \`get_weather\` — do not invent numbers.
2. Speak a short reply: place, temperature in Celsius, conditions; humidity/wind only if useful.
3. Example: "In London it's about 12 degrees and overcast, with light wind."
4. Do **not** speak the tool name or dump JSON. Plain spoken English only.
5. If the tool errors (unknown place), say so and ask for a clearer place name.
`,
});
