/**
 * Normalize model stream text into plain spoken English.
 * Some models emit AG-UI / content-part JSON (sometimes with spaces around keys).
 */

function unescapeJsonString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function textsFromUnknown(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    const t = value.trim();
    if (t) out.push(t);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) textsFromUnknown(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === "string") {
    out.push(obj.text);
    return;
  }
  if (obj.content !== undefined) textsFromUnknown(obj.content, out);
}

/** Strip a leading content-part JSON wrapper, including partial streams. */
function stripContentPartWrapper(raw: string): string {
  let s = raw.trim();
  if (!s) return "";

  // Full JSON object / array
  if (
    (s.startsWith("{") && s.endsWith("}")) ||
    (s.startsWith("[") && s.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(s) as unknown;
      const parts: string[] = [];
      textsFromUnknown(parsed, parts);
      if (parts.length) return parts.join(" ").trim();
    } catch {
      // fall through — may be almost-JSON from the model
    }
  }

  // Prefix like: { "content" : [ { "type" : "text" , "text" : "
  // (model sometimes inserts spaces around keys because of voice instructions)
  const prefix =
    /^\s*\{\s*"?\s*content\s*"?\s*:\s*\[\s*\{\s*"?\s*type\s*"?\s*:\s*"\s*text\s*"\s*,\s*"?\s*text\s*"?\s*:\s*"/i;
  if (prefix.test(s)) {
    s = s.replace(prefix, "");
    // Trailing: " } ] }  or incomplete
    s = s.replace(/"\s*\}\s*(?:,\s*\{[\s\S]*)?\s*\]\s*\}\s*$/i, "");
    s = s.replace(/"\s*$/, "");
    return unescapeJsonString(s).trim();
  }

  // Any "text":"..." occurrences inside a content blob
  if (/content\s*"?\s*:/i.test(s) && /"\s*text\s*"\s*:/i.test(s)) {
    const texts: string[] = [];
    const re = /"\s*text\s*"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      texts.push(unescapeJsonString(m[1]!));
    }
    if (texts.length) return texts.join(" ").trim();
  }

  return s;
}

/** Collapse odd spaces the model inserts inside words after JSON stripping. */
function tidySpoken(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

export function toSpokenReply(raw: string): string {
  return tidySpoken(stripContentPartWrapper(raw));
}
