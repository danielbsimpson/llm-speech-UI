"""
backend/weather.py
Weather data fetching via Open-Meteo (free, no API key required).
Exposes a single GET /weather endpoint that returns current conditions
and a 7-day daily forecast as structured JSON.
"""

import os
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_LOCATION_ENV  = os.getenv("WEATHER_LOCATION", "Framingham,Massachusetts")
_UNITS         = os.getenv("WEATHER_UNITS", "fahrenheit").lower()
_CACHE_SECONDS = int(os.getenv("WEATHER_CACHE_SECONDS", "600"))

# ── In-memory cache ──────────────────────────────────────────────────────────
# Structure: { location_key: { "ts": float, "data": dict } }
_cache: dict = {}

# ── WMO weather code → human-readable label ──────────────────────────────────
WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}


async def _geocode(location: str) -> tuple[float, float, str]:
    """
    Resolve a location string to (lat, lon, resolved_name).
    Accepts either a city name ("Framingham,Massachusetts") or
    a "lat,lon" string ("42.2793,-71.4162").
    """
    if "," in location:
        parts = location.split(",")
        # Detect numeric lat/lon vs "City, State"
        try:
            lat = float(parts[0].strip())
            lon = float(parts[1].strip())
            return lat, lon, location
        except ValueError:
            pass  # fall through to geocoding

    city = location.split(",")[0].strip()
    url = f"https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1&language=en&format=json"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        results = resp.json().get("results")
        if not results:
            raise HTTPException(status_code=404, detail=f"Location not found: {location}")
        r = results[0]
        name = f"{r['name']}, {r.get('admin1', '')} {r.get('country_code', '')}".strip(", ")
        return r["latitude"], r["longitude"], name


async def _fetch_weather(lat: float, lon: float) -> dict:
    """Call Open-Meteo for current conditions + 7-day daily forecast."""
    temp_unit = "fahrenheit" if _UNITS == "fahrenheit" else "celsius"
    wind_unit = "mph" if _UNITS == "fahrenheit" else "kmh"

    params = {
        "latitude":  lat,
        "longitude": lon,
        "current": ",".join([
            "temperature_2m", "apparent_temperature", "relative_humidity_2m",
            "wind_speed_10m", "wind_direction_10m", "weather_code",
            "cloud_cover", "precipitation", "is_day",
        ]),
        "daily": ",".join([
            "weather_code", "temperature_2m_max", "temperature_2m_min",
            "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset",
        ]),
        "temperature_unit":  temp_unit,
        "wind_speed_unit":   wind_unit,
        "precipitation_unit": "inch" if _UNITS == "fahrenheit" else "mm",
        "timezone":          "auto",
        "forecast_days":     7,
    }
    url = "https://api.open-meteo.com/v1/forecast"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


def _wind_direction_label(degrees: float) -> str:
    dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return dirs[round(degrees / 45) % 8]


def _build_response(raw: dict, location_name: str) -> dict:
    """Shape the raw Open-Meteo JSON into a clean, frontend-ready dict."""
    cur   = raw["current"]
    daily = raw["daily"]
    unit_temp   = "°F" if _UNITS == "fahrenheit" else "°C"
    unit_wind   = "mph" if _UNITS == "fahrenheit" else "km/h"
    unit_precip = "in" if _UNITS == "fahrenheit" else "mm"

    current = {
        "condition":     WMO_CODES.get(cur["weather_code"], "Unknown"),
        "weather_code":  cur["weather_code"],
        "temp":          round(cur["temperature_2m"]),
        "feels_like":    round(cur["apparent_temperature"]),
        "humidity":      cur["relative_humidity_2m"],
        "wind_speed":    round(cur["wind_speed_10m"]),
        "wind_dir":      _wind_direction_label(cur["wind_direction_10m"]),
        "cloud_cover":   cur["cloud_cover"],
        "precipitation": cur["precipitation"],
        "is_day":        bool(cur["is_day"]),
        "unit_temp":     unit_temp,
        "unit_wind":     unit_wind,
        "unit_precip":   unit_precip,
    }

    forecast = []
    for i in range(len(daily["time"])):
        day_name = datetime.fromisoformat(daily["time"][i]).strftime("%A")
        forecast.append({
            "day":          day_name,
            "date":         daily["time"][i],
            "condition":    WMO_CODES.get(daily["weather_code"][i], "Unknown"),
            "weather_code": daily["weather_code"][i],
            "high":         round(daily["temperature_2m_max"][i]),
            "low":          round(daily["temperature_2m_min"][i]),
            "precip":       daily["precipitation_sum"][i],
            "wind_max":     round(daily["wind_speed_10m_max"][i]),
            "sunrise":      daily["sunrise"][i].split("T")[1] if "T" in daily["sunrise"][i] else daily["sunrise"][i],
            "sunset":       daily["sunset"][i].split("T")[1] if "T" in daily["sunset"][i] else daily["sunset"][i],
        })

    # Build a compact plain-prose context string for LLM injection.
    f0 = forecast[0]  # today
    llm_context = (
        f"Current weather in {location_name}: {current['condition']}, "
        f"{current['temp']}{unit_temp} (feels like {current['feels_like']}{unit_temp}), "
        f"humidity {current['humidity']}%, wind {current['wind_speed']} {unit_wind} {current['wind_dir']}, "
        f"cloud cover {current['cloud_cover']}%, precipitation {current['precipitation']} {unit_precip}. "
        f"Today: high {f0['high']}{unit_temp}, low {f0['low']}{unit_temp}, {f0['condition']}. "
        f"Sunrise {f0['sunrise']}, sunset {f0['sunset']}. "
        "Upcoming: " +
        ", ".join(
            f"{d['day']} {d['high']}/{d['low']}{unit_temp} {d['condition']}"
            for d in forecast[1:5]
        ) + "."
    )

    return {
        "location":   location_name,
        "current":    current,
        "forecast":   forecast,
        "llm_context": llm_context,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "units":      _UNITS,
    }


@router.get("/weather")
async def get_weather(location: Optional[str] = None):
    """
    Return current weather + 7-day forecast for the configured or requested location.
    Results are cached for WEATHER_CACHE_SECONDS to avoid redundant API calls.

    Query param ?location= overrides the .env default for one-off lookups
    (e.g. "check the weather in London").
    """
    loc_str   = location or _LOCATION_ENV
    cache_key = loc_str.lower().strip()

    # Check cache
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

    lat, lon, resolved_name = await _geocode(loc_str)
    raw  = await _fetch_weather(lat, lon)
    data = _build_response(raw, resolved_name)

    _cache[cache_key] = {"ts": time.time(), "data": data}
    return data
