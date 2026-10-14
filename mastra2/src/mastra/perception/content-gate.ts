/** Noise / filler tokens that must not start a think turn. */
const NOISE_ONLY =
  /^(um+|uh+|ah+|er+|hmm+|mhm+|mm+|\[.*\]|\(.*\)|<.*|…|\.+)$/i;

/**
 * US17-style content gate: require real words before acting on a turn.
 */
export function hasSpeechContent(
  text: string,
  minChars = Number(process.env.ASR_MIN_CHARS || 2),
): boolean {
  const t = text.trim();
  if (t.length < minChars) return false;
  if (NOISE_ONLY.test(t)) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  return true;
}

/** RMS of int16 PCM in 0..1. */
export function pcmRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = samples[i]! / 32768;
    sum += n * n;
  }
  return Math.sqrt(sum / samples.length);
}
