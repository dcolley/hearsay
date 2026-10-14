/** Return end index (exclusive) of the first complete sentence, or null. */
export function firstCompleteSentence(buf: string): number | null {
  const match = buf.match(/[.!?…](?=\s|$)/);
  if (!match || match.index === undefined) return null;
  return match.index + match[0].length;
}
