import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  createHearsayMemory,
  hearsayResourceId,
} from "../memory/hearsay-memory.ts";
import { mergeFrameIntoWorkingMemory } from "../memory/merge-scene.ts";
import type { ClientBridgeHandle } from "../perception/client-bridge.ts";
import {
  describeScreenshotFrame,
  describeWebcamFrame,
} from "../perception/describe-frame.ts";

const sceneMemory = createHearsayMemory();

function getBridge(requestContext: unknown): ClientBridgeHandle | undefined {
  if (
    requestContext &&
    typeof requestContext === "object" &&
    "get" in requestContext &&
    typeof (requestContext as { get: (k: string) => unknown }).get === "function"
  ) {
    return (requestContext as { get: (k: string) => unknown }).get(
      "clientBridge",
    ) as ClientBridgeHandle | undefined;
  }
  return undefined;
}

export const askUserTool = createTool({
  id: "ask_user",
  description:
    "Ask the user a clarifying question and wait for their answer before continuing.",
  inputSchema: z.object({
    question: z.string().describe("Short spoken/plain question for the user"),
  }),
  outputSchema: z.object({
    answer: z.string(),
  }),
  execute: async (input, context) => {
    const bridge = getBridge(context?.requestContext);
    if (!bridge) {
      return {
        answer:
          "Client bridge unavailable. In CopilotKit chat, use the ask_user HITL UI; in presence, reconnect the mic session.",
      };
    }
    const result = (await bridge.call("ask_user", {
      question: input.question,
    })) as { answer?: string };
    return { answer: String(result?.answer ?? "").trim() || "(no answer)" };
  },
});

export const offerChoicesTool = createTool({
  id: "offer_choices",
  description:
    "REQUIRED whenever the user asks for choices, options, a menu, or anything to pick from. Present 2–6 short clickable/speakable titles. Do NOT write numbered options in your spoken reply — put them only in this tool's choices array. Speak one short invite sentence, then call this tool.",
  inputSchema: z.object({
    prompt: z
      .string()
      .describe("Short question shown above the choices, e.g. Which track?"),
    choices: z
      .array(z.string().min(1).max(80))
      .min(2)
      .max(6)
      .describe("Short option labels the user can say or click"),
  }),
  outputSchema: z.object({
    choice: z.string(),
    index: z.number(),
    answer: z.string(),
  }),
  execute: async (input, context) => {
    const bridge = getBridge(context?.requestContext);
    if (!bridge) {
      return {
        choice: "",
        index: -1,
        answer:
          "Client bridge unavailable. In CopilotKit chat, use the offer_choices HITL UI; in presence, reconnect the mic session.",
      };
    }
    const result = (await bridge.call("offer_choices", {
      prompt: input.prompt,
      choices: input.choices,
    })) as { choice?: string; index?: number; answer?: string };
    const choice = String(result?.choice ?? result?.answer ?? "").trim();
    const index =
      typeof result?.index === "number" ? result.index : -1;
    return {
      choice: choice || "(no choice)",
      index,
      answer: choice || "(no choice)",
    };
  },
});

const cameraFrameOutputSchema = z.object({
  ok: z.boolean(),
  /** Grounded visual description from a multimodal user-message call. */
  description: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** Present for app/UI only — stripped from model-facing output. */
  dataUrl: z.string().optional(),
});

type CameraFrameOutput = z.infer<typeof cameraFrameOutputSchema>;

/**
 * Spark (openai-compatible chat) JSON.stringifies tool `content` parts, so
 * images in toModelOutput never become vision inputs. Return text only.
 */
function cameraFrameToModelOutput(output: CameraFrameOutput) {
  if (!output.ok) {
    return {
      type: "text" as const,
      value:
        output.description?.trim() ||
        "Camera capture failed. Ask the user to enable the webcam in Presence.",
    };
  }

  const description = output.description?.trim();
  if (!description) {
    return {
      type: "text" as const,
      value:
        "Frame captured but no visual description is available. Say you cannot see the scene yet.",
    };
  }

  const size =
    output.width && output.height
      ? ` (${output.width}x${output.height})`
      : "";

  return {
    type: "text" as const,
    value: `Webcam view${size}: ${description}`,
  };
}

export const requestCameraFrameTool = createTool({
  id: "request_camera_frame",
  description:
    "Request a fresh webcam frame (camera facing the user/room) and receive a grounded description. Use for the physical scene, person, hands, or room. Do NOT use for the computer screen, desktop, or UI — use capture_screenshot instead.",
  inputSchema: z.object({
    reason: z
      .string()
      .optional()
      .describe("Why you need a new look at the scene"),
  }),
  outputSchema: cameraFrameOutputSchema,
  execute: async (input, context) => {
    const bridge = getBridge(context?.requestContext);
    if (!bridge) {
      return {
        ok: false,
        description:
          "No client camera bridge. Open presence or CopilotKit with camera tools enabled.",
      };
    }

    const result = (await bridge.call("request_camera_frame", {
      reason: input.reason ?? "",
    })) as {
      ok?: boolean;
      description?: string;
      dataUrl?: string;
      width?: number;
      height?: number;
    };

    if (!result?.ok || !result.dataUrl?.startsWith("data:image/")) {
      return {
        ok: false,
        description:
          result?.description?.trim() ||
          "Camera capture failed or returned no image.",
        width: result?.width,
        height: result?.height,
      };
    }

    try {
      const visual = await describeWebcamFrame(result.dataUrl, {
        reason: input.reason,
      });
      try {
        await mergeFrameIntoWorkingMemory(
          sceneMemory,
          {
            description: visual,
            dataUrl: result.dataUrl,
            width: result.width,
            height: result.height,
          },
          { resourceId: hearsayResourceId },
        );
      } catch (wmErr) {
        console.warn(
          "[request_camera_frame] working memory update failed:",
          wmErr instanceof Error ? wmErr.message : wmErr,
        );
      }
      return {
        ok: true,
        description: visual,
        width: result.width,
        height: result.height,
        // Keep for UI/debug; toModelOutput omits it
        dataUrl: result.dataUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[request_camera_frame] describe failed:", message);
      return {
        ok: false,
        description: `Captured a frame but could not describe it (${message}).`,
        width: result.width,
        height: result.height,
      };
    }
  },
  toModelOutput: cameraFrameToModelOutput,
});

function screenshotToModelOutput(output: CameraFrameOutput) {
  if (!output.ok) {
    return {
      type: "text" as const,
      value:
        output.description?.trim() ||
        "Screenshot failed. Ask the user to allow screen/window share when the browser prompts.",
    };
  }

  const description = output.description?.trim();
  if (!description) {
    return {
      type: "text" as const,
      value:
        "Screenshot captured but no description is available. Ask to try again.",
    };
  }

  const size =
    output.width && output.height
      ? ` (${output.width}x${output.height})`
      : "";

  return {
    type: "text" as const,
    value: `Screen capture${size}: ${description}`,
  };
}

export const captureScreenshotTool = createTool({
  id: "capture_screenshot",
  description:
    "REQUIRED when the user says look at the screen/display/desktop/monitor or asks what is on screen. Captures screen, window, or browser tab via the browser share picker and returns a grounded UI description. Not for webcam — use request_camera_frame for the camera.",
  inputSchema: z.object({
    reason: z
      .string()
      .optional()
      .describe(
        "What you need to see or help with, e.g. 'read the error dialog' or 'find the Save button'",
      ),
  }),
  outputSchema: cameraFrameOutputSchema,
  execute: async (input, context) => {
    const bridge = getBridge(context?.requestContext);
    if (!bridge) {
      return {
        ok: false,
        description:
          "No client bridge. Open Presence (mic connected) or CopilotKit chat with screenshot tools enabled.",
      };
    }

    const result = (await bridge.call("capture_screenshot", {
      reason: input.reason ?? "",
    })) as {
      ok?: boolean;
      description?: string;
      dataUrl?: string;
      width?: number;
      height?: number;
    };

    if (!result?.ok || !result.dataUrl?.startsWith("data:image/")) {
      return {
        ok: false,
        description:
          result?.description?.trim() ||
          "Screenshot failed or returned no image.",
        width: result?.width,
        height: result?.height,
      };
    }

    try {
      const visual = await describeScreenshotFrame(result.dataUrl, {
        reason: input.reason,
      });
      return {
        ok: true,
        description: visual,
        width: result.width,
        height: result.height,
        dataUrl: result.dataUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[capture_screenshot] describe failed:", message);
      return {
        ok: false,
        description: `Captured the screen but could not describe it (${message}).`,
        width: result.width,
        height: result.height,
      };
    }
  },
  toModelOutput: screenshotToModelOutput,
});
