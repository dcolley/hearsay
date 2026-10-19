/**
 * Server-tool intent matcher (ADR-007 fix round, IMPORTANT-2a).
 *
 * The speculative gate runs with tools OFF. Client-tool needs are already
 * caught by the describe-frame regexes; this module catches utterances whose
 * answer requires a SERVER tool (weather, web search). If the gate missed
 * those, a provider honoring toolChoice:'none' would answer from the model's
 * own (stale/hallucinated) knowledge with the tool never executed.
 *
 * The phrase tables are derived from the tools' own descriptions:
 * - weather-tool.ts: "Get current weather for a city or place ...
 *   temperature, conditions, humidity, wind"
 * - web-search-tool.ts: "Search the live web for current facts, news,
 *   and sources ... recent events"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeWeatherQuestion, looksLikeWebSearch, needsServerTool } from "./server-tool-intent.ts";

describe("server-tool intent matcher (ADR-007 fix round)", () => {
  it("weather: every everyday phrasing is caught", () => {
    const phrases = [
      "what is the weather in london today",
      "what's the weather like outside",
      "how's the weather tomorrow",
      "give me the weather forecast for paris",
      "will it rain later",
      "is it going to snow this weekend",
      "do i need an umbrella",
      "what's the temperature outside",
      "how hot is it today",
      "how cold will it be tonight",
      "is it sunny right now",
      "is it raining",
      "wind speed in rome",
      "what is the humidity like",
      "degrees outside right now",
    ];
    for (const p of phrases) {
      assert.equal(looksLikeWeatherQuestion(p), true, `weather: ${p}`);
      assert.equal(needsServerTool(p), true, `weather: ${p}`);
    }
  });

  it("web search: every everyday phrasing is caught", () => {
    const phrases = [
      "search the web for the latest on ai",
      "do a web search for quantum computing",
      "look up the capital of australia",
      "looked up that word yesterday",
      "google the newest graphics card",
      "googling recent startup funding",
      "what is the latest news on the election",
      "current events in the middle east",
      "any recent developments on that",
      "what's happening with the stock market",
      "news about the transit strike",
      "find out who won yesterday's match online",
      "check online for the price of gold",
      "what is the newest version of node",
    ];
    for (const p of phrases) {
      assert.equal(looksLikeWebSearch(p), true, `search: ${p}`);
      assert.equal(needsServerTool(p), true, `search: ${p}`);
    }
  });

  it("plain conversation is NOT tool-needful (must stay speculatable)", () => {
    const phrases = [
      "what is two plus two",
      "tell me a joke about robots",
      "remember that i like coffee",
      "what did i say before",
      "translate hello to french",
      "how do i bake bread",
      "what's the meaning of life",
      "give me some options for dinner",
      "help me with this code",
      "good morning",
      "thanks a lot",
      "write a haiku about rain", // rain-as-word, not a weather query
      "what is on my screen",
      "the room is warm, change the setting",
    ];
    for (const p of phrases) {
      assert.equal(needsServerTool(p), false, `false-positive: ${p}`);
    }
  });

  it("matching is case-insensitive and position-independent", () => {
    assert.equal(needsServerTool("WEATHER forecast?"), true);
    assert.equal(needsServerTool("any NEWS about that"), true);
    assert.equal(needsServerTool("Look it UP for me"), true);
  });
});
