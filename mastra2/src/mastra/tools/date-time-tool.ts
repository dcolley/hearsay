import { z } from "zod";
import { withToolContract } from "./with-contract.ts";

const DEFAULT_TZ =
  process.env.HEARSAY_TIMEZONE?.trim() ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  "UTC";

const outputSchema = z.object({
  ok: z.boolean(),
  timezone: z.string(),
  /** ISO-8601 instant (UTC). */
  iso: z.string(),
  /** Calendar date in the timezone, YYYY-MM-DD. */
  date: z.string(),
  /** 24h time in the timezone, HH:mm:ss. */
  time: z.string(),
  /** Weekday name in English. */
  weekday: z.string(),
  /** Spoken-friendly line for TTS. */
  spoken: z.string(),
  unixMs: z.number(),
  error: z.string().optional(),
});

type DateTimeOutput = z.infer<typeof outputSchema>;

function dateTimeToModelOutput(output: DateTimeOutput) {
  if (!output.ok) {
    return {
      type: "text" as const,
      value: output.error || "Could not resolve date and time.",
    };
  }
  return {
    type: "text" as const,
    value: output.spoken,
  };
}

function partsInZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const y = map.year!;
  const monthNum = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "2-digit",
  }).format(date);
  const dayNum = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
  }).format(date);
  const dateYmd = `${y}-${monthNum}-${dayNum}`;
  const time = `${map.hour}:${map.minute}:${map.second}`;
  const spokenDate = `${map.weekday}, ${map.day} ${map.month} ${map.year}`;
  const spokenTime = `${map.hour}:${map.minute}`;
  return {
    date: dateYmd,
    time,
    weekday: map.weekday!,
    spoken: `It is ${spokenTime} on ${spokenDate} (${timeZone}).`,
  };
}

function resolveZone(input?: string): string {
  const tz = input?.trim() || DEFAULT_TZ;
  try {
    // Throws RangeError for invalid IANA zones
    Intl.DateTimeFormat(undefined, { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    throw new Error(
      `Unknown timezone "${tz}". Use an IANA name like Europe/London or America/New_York.`,
    );
  }
}

/** Current local (or requested) date and time. */
export const getDateTimeTool = withToolContract({
  id: "get_date_time",
  description:
    "Get the current date and time. Use whenever the user asks what time or day it is, or you need an accurate now for scheduling. Optional IANA timezone (e.g. Europe/London).",
  inputSchema: z.object({
    timezone: z
      .string()
      .optional()
      .describe(
        "IANA timezone, e.g. Europe/London, America/New_York. Defaults to server local / HEARSAY_TIMEZONE.",
      ),
  }),
  outputSchema,
  execute: async (input) => {
    try {
      const timezone = resolveZone(input.timezone);
      const now = new Date();
      const parts = partsInZone(now, timezone);
      return {
        ok: true,
        timezone,
        iso: now.toISOString(),
        date: parts.date,
        time: parts.time,
        weekday: parts.weekday,
        spoken: parts.spoken,
        unixMs: now.getTime(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        timezone: input.timezone?.trim() || DEFAULT_TZ,
        iso: "",
        date: "",
        time: "",
        weekday: "",
        spoken: "",
        unixMs: 0,
        error: message,
      };
    }
  },
  toModelOutput: dateTimeToModelOutput,
});

/** Interpret an ISO / date string in a timezone (or convert "now" relative display). */
export const formatDateTimeTool = withToolContract({
  id: "format_date_time",
  description:
    "Format or convert a specific date/time into a timezone. Pass an ISO-8601 string (or YYYY-MM-DD). Use for 'what day is that' / timezone conversion — not for current time (use get_date_time).",
  inputSchema: z.object({
    when: z
      .string()
      .describe(
        "ISO-8601 datetime, or date-only YYYY-MM-DD (treated as noon UTC that day)",
      ),
    timezone: z
      .string()
      .optional()
      .describe("IANA timezone for the output. Defaults to server local / HEARSAY_TIMEZONE."),
  }),
  outputSchema,
  execute: async (input) => {
    try {
      const timezone = resolveZone(input.timezone);
      const raw = input.when.trim();
      const parsed =
        /^\d{4}-\d{2}-\d{2}$/.test(raw)
          ? new Date(`${raw}T12:00:00.000Z`)
          : new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Could not parse date/time: ${raw}`);
      }
      const parts = partsInZone(parsed, timezone);
      return {
        ok: true,
        timezone,
        iso: parsed.toISOString(),
        date: parts.date,
        time: parts.time,
        weekday: parts.weekday,
        spoken: `That is ${parts.time.slice(0, 5)} on ${parts.weekday}, ${parts.date} in ${timezone}.`,
        unixMs: parsed.getTime(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        timezone: input.timezone?.trim() || DEFAULT_TZ,
        iso: "",
        date: "",
        time: "",
        weekday: "",
        spoken: "",
        unixMs: 0,
        error: message,
      };
    }
  },
  toModelOutput: dateTimeToModelOutput,
});
