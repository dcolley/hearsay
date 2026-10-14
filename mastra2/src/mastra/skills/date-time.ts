import { createSkill } from "@mastra/core/skills";

/**
 * Accurate clock / calendar via server date-time tools.
 */
export const dateTimeSkill = createSkill({
  name: "date-time",
  description:
    "Use when the user asks what time or day it is, for a timezone, or to interpret a specific date.",
  instructions: `
# Date and time

## Tools

- \`get_date_time\` — current date and time.
  - Optional \`timezone\`: IANA name (Europe/London, America/New_York). Omit for default (HEARSAY_TIMEZONE or server local).
- \`format_date_time\` — format/convert a given ISO datetime or YYYY-MM-DD into a timezone.
  - Required \`when\`; optional \`timezone\`.

## When to call

1. "What time is it?" / "What day is it?" → \`get_date_time\`.
2. "What time is it in Tokyo?" → \`get_date_time\` with that timezone.
3. A specific date or ISO stamp to explain → \`format_date_time\`.
4. Do **not** invent the clock from memory — always call a tool.

## How to answer

1. Speak from the tool's result (use \`spoken\` / the text summary).
2. Keep it short: time and weekday/date; mention the timezone if they asked for one.
3. Do **not** speak the tool name or dump JSON.
`,
});
