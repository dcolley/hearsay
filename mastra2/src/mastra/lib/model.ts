/**
 * Spark is OpenAI-compatible Chat Completions only — it rejects Responses API
 * `item_reference` payloads. Always pin `api: "chat"` and pass Spark's base URL
 * so Mastra does not use the built-in openai `.responses()` path.
 */
export function sparkModel() {
  const raw =
    process.env.OPENAI_MODEL?.trim() || "openai/qwen3.8-flash-next";
  const modelId = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
  const url = process.env.OPENAI_BASE_URL?.trim();
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "sk-dummy";

  if (url) {
    return {
      providerId: "spark",
      modelId,
      url,
      apiKey,
      api: "chat" as const,
    };
  }

  return {
    providerId: "openai",
    modelId,
    apiKey,
    api: "chat" as const,
  };
}
