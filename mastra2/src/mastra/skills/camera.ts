import { createSkill } from "@mastra/core/skills";

/**
 * How to use laptop camera tools (presence WS bridge + CopilotKit frontend tool).
 */
export const cameraSkill = createSkill({
  name: "camera",
  description:
    "Use when the user asks what you can see, what is in front of the camera, or to look / check the scene / update objects in view.",
  instructions: `
# Camera / scene

## Tools

- \`request_camera_frame\` — ask the laptop for a fresh webcam capture, then get a grounded visual description back as text.
  - Optional arg \`reason\`: short why (e.g. "user asked what I can see").
  - Presence: fulfilled over WebSocket \`client.action\` (mic session must be connected; Start video if needed).
  - CopilotKit chat: fulfilled by the browser \`useFrontendTool\` handler (same tool name).

## When to call

1. User asks what you see on the **webcam** / room / person / hands / physical scene.
2. Working memory has no recent camera note, or the user says the scene changed.
3. You are unsure about the physical scene — call the tool instead of inventing objects.

## Do NOT use for

- "Look at the screen / display / desktop / monitor" or UI/errors on the computer → use \`capture_screenshot\` instead.

## After the tool returns

- Trust the tool \`description\` — that text was produced by looking at the current JPEG.
- Speak from that description. Do not invent a different room, clothing, or objects.
- If \`ok\` is false, say you could not get the camera / describe the frame.
- Do **not** speak the tool name or narrate "I'm calling request_camera_frame". Just act, then answer in plain spoken English.

## Related

- \`ask_user\` — only if you need a clarifying question from the human before looking or answering.
`,
});
