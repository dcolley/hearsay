/**
 * Server-tool intent matcher (ADR-007 fix round, IMPORTANT-2a).
 *
 * The speculative gate streams with tools OFF. Client-tool needs (screenshot,
 * webcam, offer_choices) are caught by describe-frame.ts / wantsOfferChoices;
 * this module catches utterances whose answer needs a SERVER tool. Without
 * it, a provider honoring `toolChoice: "none"` would answer a weather or
 * web-search question from model memory - the tool never runs and the answer
 * is fabricated. Matched utterances never start a speculative stream; the
 * turn goes straight through the ordinary path where tools are available.
 *
 * Tables are derived from the tools' own descriptions (weather-tool.ts:
 * "current weather ... temperature, conditions, humidity, wind";
 * web-search-tool.ts: "live web ... current facts, news ... recent events").
 * Rule: an utterance matches a family when it carries one of that family's
 * distinctive vocabulary items - a domain noun (weather, forecast, news,
 * umbrella, ...) or a verb-frame ("will it rain", "look ... up", "search ...
 * web"). Bare condition words ("haiku about rain") deliberately do NOT
 * match: no tool context, speculation stays allowed.
 */

const WEATHER_PATTERNS: RegExp[] = [
  /\bweather\b/i,
  /\bforecast\b/i,
  /\btemperature\b/i,
  /\bumbrella\b/i,
  /\b(degrees|celsius|fahrenheit)\b/i,
  /\bwind speed\b|\bhumidity\b/i,
  /\bhow (hot|cold|warm)\b/i,
  /\b(will|going to)\b[^.?!]{0,20}\b(rain|snow)\w*\b/i,
  /\b(is it|are things)\b[^.?!]{0,12}\b(rain|snow|sunny|cloudy|storm)\w*\b/i,
  /\bit('?s| is)\b[^.?!]{0,12}\b(rain|snow|sunny|cloudy|storm)\w*\b/i,
];

const SEARCH_PATTERNS: RegExp[] = [
  /\bsearch\b[^.?!]{0,20}\bweb\b|\bweb search\b/i,
  /\blook(ing|ed|s)?\b[^.?!]{0,12}\bup\b/i,
  /\bgoogl(e|ed|es|ing)\b/i,
  /\bnews\b|\bheadlines\b/i,
  /\b(latest|current|recent|newest) (news|developments?|updates?|events?|version|price|info|information)\b/i,
  /\bwhat('s| is| are) happening\b/i,
  /\bonline\b/i,
];

export function looksLikeWeatherQuestion(text: string): boolean {
  return WEATHER_PATTERNS.some((re) => re.test(text));
}

export function looksLikeWebSearch(text: string): boolean {
  return SEARCH_PATTERNS.some((re) => re.test(text));
}

/** True when answering would need a server tool run (weather / web search). */
export function needsServerTool(text: string): boolean {
  return looksLikeWeatherQuestion(text) || looksLikeWebSearch(text);
}
