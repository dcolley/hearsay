/**
 * One-shot multimodal describe for a webcam JPEG.
 *
 * OpenAI-compatible Chat Completions (Spark) only accept images on *user*
 * messages. Tool-result `toModelOutput` image parts are JSON.stringified and
 * never seen as pixels — so we describe here and return text to the agent.
 */

function sparkChatUrl(): { url: string; modelId: string; apiKey: string } {
  const base = process.env.OPENAI_BASE_URL?.trim();
  if (!base) {
    throw new Error("OPENAI_BASE_URL is required for webcam describe");
  }
  const raw =
    process.env.OPENAI_MODEL?.trim() || "openai/qwen3.8-flash-next";
  const modelId = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "sk-dummy";
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  return { url, modelId, apiKey };
}

/** Utterances about the computer display — use capture_screenshot, not webcam. */
export function needsScreenshot(text: string): boolean {
  return /\b(screen|screenshot|desktop|display|monitor|my (computer|laptop|pc)|on screen|on my screen|look at (the |my )?screen|what('s| is) on (the |my )?screen|error dialog|browser (tab|window)|this (window|tab|ui|app))\b/i.test(
    text,
  );
}

/** Utterances that need a fresh webcam look before answering (not screen/UI). */
export function needsLiveVision(text: string): boolean {
  if (needsScreenshot(text)) return false;
  return /\b(see|saw|look|looking|camera|webcam|holding|hold|hand|hands|wearing|wear|colour|color|behind|in front|face|desk|room|picture|visible|what am i|what do i|how many|who is)\b/i.test(
    text,
  );
}

export async function describeWebcamFrame(
  dataUrl: string,
  opts?: { reason?: string },
): Promise<string> {
  return describeImageFrame(dataUrl, {
    kind: "webcam",
    reason: opts?.reason,
  });
}

/** Desktop / window / browser-tab screenshot from getDisplayMedia. */
export async function describeScreenshotFrame(
  dataUrl: string,
  opts?: { reason?: string },
): Promise<string> {
  return describeImageFrame(dataUrl, {
    kind: "screenshot",
    reason: opts?.reason,
  });
}

async function describeImageFrame(
  dataUrl: string,
  opts: { kind: "webcam" | "screenshot"; reason?: string },
): Promise<string> {
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("Expected a data:image JPEG/PNG URL");
  }

  const { url, modelId, apiKey } = sparkChatUrl();
  const reason = opts.reason?.trim();
  const prompt =
    opts.kind === "screenshot"
      ? [
          "Look at this laptop screen screenshot carefully.",
          "Answer ONLY from pixels you can see on the screen.",
          "Name visible apps, windows, dialogs, error text, buttons, and key UI labels when readable.",
          "If text is too small or blurry, say so — do not invent menu items or code.",
          "Help the user with the on-screen task; be concrete.",
          "Reply in 2-5 short spoken sentences.",
          reason
            ? `User question / task: ${reason}`
            : "Describe what is on screen and what the user might do next.",
        ].join(" ")
      : [
          "Look at this laptop webcam photo carefully.",
          "Answer ONLY from pixels you can see.",
          "If the user's question asks about hands or held objects and hands are out of frame, say you cannot see their hands — do not invent a phone, pen, or other object.",
          "Never invent smartphones, remotes, kennels, or furniture that are not clearly visible.",
          "Reply in 1-3 short spoken sentences.",
          reason ? `User question: ${reason}` : "Describe the person and scene.",
        ].join(" ");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      max_tokens: opts.kind === "screenshot" ? 360 : 220,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Vision describe failed (${res.status}): ${body.slice(0, 240)}`,
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Vision describe returned empty content");
  }
  return text;
}
