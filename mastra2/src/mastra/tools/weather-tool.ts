import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** WMO weather interpretation codes (Open-Meteo). */
function conditionsFromCode(code: number): string {
  if (code === 0) return "clear";
  if (code === 1) return "mainly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code >= 56 && code <= 57) return "freezing drizzle";
  if (code >= 61 && code <= 65) return "rain";
  if (code >= 66 && code <= 67) return "freezing rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code >= 85 && code <= 86) return "snow showers";
  if (code === 95) return "thunderstorm";
  if (code === 96 || code === 99) return "thunderstorm with hail";
  return `weather code ${code}`;
}

type GeocodeResult = {
  results?: Array<{
    name: string;
    country?: string;
    admin1?: string;
    latitude: number;
    longitude: number;
  }>;
};

type ForecastResult = {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
};

async function fetchCurrentWeather(location: string) {
  const query = location.trim() || "London";
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.searchParams.set("name", query);
  geoUrl.searchParams.set("count", "1");
  geoUrl.searchParams.set("language", "en");
  geoUrl.searchParams.set("format", "json");

  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) {
    throw new Error(`Geocoding failed (${geoRes.status})`);
  }
  const geo = (await geoRes.json()) as GeocodeResult;
  const place = geo.results?.[0];
  if (!place) {
    throw new Error(`No location found for "${query}"`);
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(place.latitude));
  forecastUrl.searchParams.set("longitude", String(place.longitude));
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
  );
  forecastUrl.searchParams.set("wind_speed_unit", "kmh");
  forecastUrl.searchParams.set("timezone", "auto");

  const forecastRes = await fetch(forecastUrl);
  if (!forecastRes.ok) {
    throw new Error(`Forecast failed (${forecastRes.status})`);
  }
  const forecast = (await forecastRes.json()) as ForecastResult;
  const current = forecast.current;
  if (!current || current.temperature_2m === undefined) {
    throw new Error(`No current weather for "${query}"`);
  }

  const label = [place.name, place.admin1, place.country]
    .filter(Boolean)
    .join(", ");

  return {
    location: label,
    temperatureCelsius: Math.round(current.temperature_2m * 10) / 10,
    conditions: conditionsFromCode(current.weather_code ?? -1),
    humidityPercent: current.relative_humidity_2m ?? null,
    windSpeedKmh:
      current.wind_speed_10m !== undefined
        ? Math.round(current.wind_speed_10m * 10) / 10
        : null,
  };
}

export const weatherTool = createTool({
  id: "get-weather",
  description:
    "Get current weather for a city or place using Open-Meteo (temperature, conditions, humidity, wind).",
  inputSchema: z.object({
    location: z
      .string()
      .describe("City or place name, e.g. London, Paris, New York"),
  }),
  outputSchema: z.object({
    location: z.string(),
    temperatureCelsius: z.number(),
    conditions: z.string(),
    humidityPercent: z.number().nullable(),
    windSpeedKmh: z.number().nullable(),
  }),
  execute: async ({ location }) => fetchCurrentWeather(location),
});
