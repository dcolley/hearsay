import { createTool } from "@mastra/core/tools";
import { getTavilyClient } from "@mastra/tavily";
import { z } from "zod";

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
});

const outputSchema = z.object({
  query: z.string(),
  answer: z.string().optional(),
  results: z.array(resultSchema),
  error: z.string().optional(),
});

type SearchOutput = z.infer<typeof outputSchema>;

/** Compact text for the model / TTS path — skip dumping long result bodies. */
function searchToModelOutput(output: SearchOutput) {
  if (output.error) {
    return {
      type: "text" as const,
      value: `Web search failed: ${output.error}`,
    };
  }

  const lines: string[] = [`Search: ${output.query}`];
  if (output.answer?.trim()) {
    lines.push(`Summary: ${output.answer.trim()}`);
  }
  const top = output.results.slice(0, 4);
  if (top.length) {
    lines.push("Sources:");
    for (const r of top) {
      const snippet = r.content.trim().slice(0, 220);
      lines.push(`- ${r.title}: ${snippet}`);
    }
  } else if (!output.answer?.trim()) {
    lines.push("No results.");
  }

  return { type: "text" as const, value: lines.join("\n") };
}

/**
 * Live web search via Tavily (same stack as Phase-0 mastra).
 * Prefer this over browser automation for spoken Q&A.
 */
export const webSearchTool = createTool({
  id: "web_search",
  description:
    "Search the live web for current facts, news, and sources. Use instead of guessing about recent events or things you do not know.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe("How many results to fetch (1–8). Default 5."),
  }),
  outputSchema,
  execute: async (input) => {
    const query = input.query.trim();
    if (!query) {
      return { query: "", results: [], error: "query is required" };
    }

    if (!process.env.TAVILY_API_KEY?.trim()) {
      return {
        query,
        results: [],
        error: "TAVILY_API_KEY is not configured",
      };
    }

    const maxResults = Math.min(Math.max(input.maxResults ?? 5, 1), 8);

    try {
      const client = getTavilyClient();
      const data = await client.search(query, {
        maxResults,
        searchDepth: "basic",
        includeAnswer: true,
      });

      return {
        query,
        answer: data.answer ?? undefined,
        results: (data.results ?? []).map((item) => ({
          title: item.title ?? "",
          url: item.url ?? "",
          content: item.content ?? "",
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { query, results: [], error: message };
    }
  },
  toModelOutput: searchToModelOutput,
});
