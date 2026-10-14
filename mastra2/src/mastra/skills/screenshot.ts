import { createSkill } from "@mastra/core/skills";

/**
 * Desktop / window screen capture for helping with on-computer tasks.
 */
export const screenshotSkill = createSkill({
  name: "screenshot",
  description:
    "Use when the user asks for help with something on their computer screen, a UI, an error dialog, a browser page, or wants you to look at their display (not the webcam).",
  instructions: `
# Screen capture / desktop help

## Tools

- \`capture_screenshot\` — browser shows a share picker (screen, window, or tab), grabs one JPEG, then returns a grounded description.
  - Optional \`reason\`: what to look for (error text, button labels, which app).
  - Presence: WebSocket \`client.action\` (mic session connected).
  - CopilotKit chat: browser \`useFrontendTool\` handler.

## When to call

1. User asks what is on screen, to read an error, or help with a desktop/UI task.
2. Guiding clicks, forms, settings, or IDE/browser work where you need pixels.
3. Do **not** use this for the webcam / room — use \`request_camera_frame\` instead.

## After the tool returns

- Trust the tool \`description\` — it was produced from the screenshot JPEG.
- Speak concrete next steps from that description. Do not invent UI that was not described.
- If \`ok\` is false (picker cancelled / blocked), ask them to allow screen share and try again.
- Do **not** speak the tool name aloud.

## Related

- \`request_camera_frame\` — webcam / physical scene only.
- \`ask_user\` / \`offer_choices\` — clarify which window or what to do next.
`,
});
