import { createSkill } from "@mastra/core/skills";

/**
 * How to use live web search (Tavily) for spoken answers.
 */
export const webSearchSkill = createSkill({
  name: "web-search",
  description:
    "Use when the user asks for current news, facts online, who/what/when lookups, or anything you should verify on the web.",
  instructions: `
# Web search

## Tool

- \`web_search\` — live search via Tavily.
  - Required: \`query\` (short search string).
  - Optional: \`maxResults\` (1–8, default 5).
  - Returns a summary answer plus short source snippets.

## When to call

1. Current events, news, "look up", "search for", sports scores, product facts.
2. Anything that may have changed recently — do not invent.
3. Prefer \`get_weather\` for weather (not this tool).

## How to answer

1. Call \`web_search\` with a focused query.
2. Speak a short reply from the summary / top sources — a few sentences.
3. You may name one source casually ("according to …") but do not read URLs aloud.
4. If the tool errors or returns nothing useful, say you could not find a clear answer.
5. Do **not** speak the tool name or dump JSON.
`,
});
