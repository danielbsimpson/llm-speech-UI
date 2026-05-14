# Weather Integration — Implementation Guide

Adds a voice-triggered weather panel that intercepts the Whisper transcript before the LLM pipeline,
fetches live weather data from a free API with no required sign-up, renders a HUD-style forecast card
inside the UI, and injects the data as context into Starling's LLM response so the spoken summary is
grounded in real current conditions.

---

## Overview

```
Microphone → Whisper STT → [intercept transcript] → /weather (FastAPI)
                                    ↓                      ↓
                           open weather panel       Open-Meteo API (free)
                                    ↓                      ↓
                           render forecast card ← weather JSON
                                    ↓
                           sendToOllama() with weather context injected
                                    ↓
                           Kokoro TTS spoken summary
```

The intercept follows the exact same pattern already used for the presentation mode dossier trigger —
the transcript is checked for a weather phrase before `sendToOllama()` is ever called.

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| Weather API | [Open-Meteo](https://open-meteo.com/) | Completely free, no API key, no account, no rate limit for personal use; returns hourly + daily JSON |
| Geocoding | Open-Meteo Geocoding API | Same domain, free, no key — resolves city names to lat/lon |
| Location default | Env var `WEATHER_LOCATION` (city name or `lat,lon`) | Configurable without a code change |
| Backend vs. frontend fetch | Backend (`weather.py`) | Avoids CORS issues; keeps API logic server-side; allows response caching |
| Caching | 10-minute in-memory cache per location | Prevents hammering the API if the user asks multiple times in quick succession |

---

## Step 1 — Add `.env` Variables

In `.env` (and `.env.example`), add:

```
# ── Weather ──────────────────────────────────────────────────────────────────
WEATHER_LOCATION=Framingham,Massachusetts   # city name OR "lat,lon" e.g. "42.2793,-71.4162"
WEATHER_UNITS=fahrenheit                    # fahrenheit | celsius
WEATHER_CACHE_SECONDS=600                   # how long to cache the last fetch (default 10 min)
```

---

## Step 2 — Create `backend/weather.py`

Create a new file `backend/weather.py`. This file owns all weather logic: geocoding, data
fetching, caching, and the FastAPI router.

```python
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
    cur  = raw["current"]
    daily = raw["daily"]
    unit_temp  = "°F" if _UNITS == "fahrenheit" else "°C"
    unit_wind  = "mph" if _UNITS == "fahrenheit" else "km/h"
    unit_precip = "in" if _UNITS == "fahrenheit" else "mm"

    current = {
        "condition":      WMO_CODES.get(cur["weather_code"], "Unknown"),
        "weather_code":   cur["weather_code"],
        "temp":           round(cur["temperature_2m"]),
        "feels_like":     round(cur["apparent_temperature"]),
        "humidity":       cur["relative_humidity_2m"],
        "wind_speed":     round(cur["wind_speed_10m"]),
        "wind_dir":       _wind_direction_label(cur["wind_direction_10m"]),
        "cloud_cover":    cur["cloud_cover"],
        "precipitation":  cur["precipitation"],
        "is_day":         bool(cur["is_day"]),
        "unit_temp":      unit_temp,
        "unit_wind":      unit_wind,
        "unit_precip":    unit_precip,
    }

    forecast = []
    for i in range(len(daily["time"])):
        day_name = datetime.fromisoformat(daily["time"][i]).strftime("%A")
        forecast.append({
            "day":        day_name,
            "date":       daily["time"][i],
            "condition":  WMO_CODES.get(daily["weather_code"][i], "Unknown"),
            "weather_code": daily["weather_code"][i],
            "high":       round(daily["temperature_2m_max"][i]),
            "low":        round(daily["temperature_2m_min"][i]),
            "precip":     daily["precipitation_sum"][i],
            "wind_max":   round(daily["wind_speed_10m_max"][i]),
            "sunrise":    daily["sunrise"][i].split("T")[1] if "T" in daily["sunrise"][i] else daily["sunrise"][i],
            "sunset":     daily["sunset"][i].split("T")[1] if "T" in daily["sunset"][i] else daily["sunset"][i],
        })

    # Build a compact plain-prose context string for LLM injection.
    # This is what gets passed as the system-role message to Starling.
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
        "location":    location_name,
        "current":     current,
        "forecast":    forecast,
        "llm_context": llm_context,
        "fetched_at":  datetime.now(timezone.utc).isoformat(),
        "units":       _UNITS,
    }


@router.get("/weather")
async def get_weather(location: Optional[str] = None):
    """
    Return current weather + 7-day forecast for the configured or requested location.
    Results are cached for WEATHER_CACHE_SECONDS to avoid redundant API calls.

    Query param ?location= overrides the .env default for one-off lookups
    (e.g. "check the weather in London").
    """
    loc_str = location or _LOCATION_ENV
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
```

---

## Step 3 — Register the Router in `backend/main.py`

In `backend/main.py`, add the import and `include_router` call alongside the existing STT and TTS
routers:

```python
# In backend/main.py, after the existing router imports:

from weather import router as weather_router
app.include_router(weather_router)
```

---

## Step 4 — Add the Weather Panel HTML

In `frontend/index.html`, add the weather panel markup. Place it **inside** the `.starling` div,
just before the `.bottom-bar` div, following the same structural pattern as the existing
presentation-mode panels.

```html
<!-- Weather Panel — zero-height, transitions in when weather mode is active -->
<div class="weather-panel hidden" id="weather-panel">
  <div class="weather-header">
    <div class="weather-location" id="weather-location">—</div>
    <div class="weather-fetched" id="weather-fetched">—</div>
  </div>

  <!-- Current conditions -->
  <div class="weather-current" id="weather-current">
    <div class="weather-temp" id="weather-temp">—</div>
    <div class="weather-condition" id="weather-condition">—</div>
    <div class="weather-detail-grid">
      <span class="wd-lbl">FEELS LIKE</span><span class="wd-val" id="weather-feels">—</span>
      <span class="wd-lbl">HUMIDITY</span><span class="wd-val" id="weather-humidity">—</span>
      <span class="wd-lbl">WIND</span><span class="wd-val" id="weather-wind">—</span>
      <span class="wd-lbl">CLOUD COVER</span><span class="wd-val" id="weather-cloud">—</span>
      <span class="wd-lbl">SUNRISE</span><span class="wd-val" id="weather-sunrise">—</span>
      <span class="wd-lbl">SUNSET</span><span class="wd-val" id="weather-sunset">—</span>
    </div>
  </div>

  <!-- 7-day forecast strip -->
  <div class="weather-forecast" id="weather-forecast"></div>
</div>
```

---

## Step 5 — Add the CSS

Append the following block to `frontend/style.css`. The panel fades in from the bottom of the chat
column — it doesn't invoke the pres-mode layout change, so the sphere and waveform remain visible.

```css
/* ── Weather Panel ──────────────────────────────────────────────────────────── */

.weather-panel {
  width: 100%;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 18px 20px 14px;
  margin-top: 12px;
  animation: weatherFadeIn 0.35s ease;
  overflow: hidden;
}

.weather-panel.hidden {
  display: none;
}

@keyframes weatherFadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

.weather-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 8px;
}

.weather-location {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.8rem, 1.5vw, 1rem);
  letter-spacing: 0.12em;
  color: #e0e0e0;
  text-transform: uppercase;
}

.weather-fetched {
  font-size: 0.65rem;
  color: #555;
  letter-spacing: 0.08em;
}

.weather-current {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}

.weather-temp {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(2rem, 5vw, 3.2rem);
  color: #ffffff;
  line-height: 1;
  letter-spacing: -0.02em;
}

.weather-condition {
  font-size: clamp(0.7rem, 1.3vw, 0.9rem);
  color: #aaa;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.weather-detail-grid {
  display: grid;
  grid-template-columns: repeat(3, auto 1fr);
  column-gap: 16px;
  row-gap: 5px;
  margin-top: 8px;
}

.wd-lbl {
  font-size: 0.6rem;
  color: #555;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  align-self: center;
}

.wd-val {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.75rem;
  color: #ccc;
}

/* 7-day forecast strip */
.weather-forecast {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
}

.weather-forecast::-webkit-scrollbar { display: none; }

.forecast-day {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 7px;
  min-width: 64px;
}

.forecast-day-name {
  font-size: 0.6rem;
  color: #666;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.forecast-day-icon {
  font-size: 1.3rem;
  line-height: 1;
}

.forecast-day-high {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.8rem;
  color: #e0e0e0;
}

.forecast-day-low {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.7rem;
  color: #555;
}

.forecast-day-cond {
  font-size: 0.55rem;
  color: #666;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  max-width: 60px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

---

## Step 6 — Create `frontend/weather-panel.js`

Create a new file `frontend/weather-panel.js`. Keeping this logic separate from `app.js` mirrors
the `browser-panel.js` pattern already established in `WEBCALL.md`.

```javascript
// frontend/weather-panel.js
// Weather panel: trigger detection, data fetch, render, and LLM context export.

const BACKEND_BASE_WX = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const wxPanel     = document.getElementById('weather-panel');
const wxLocation  = document.getElementById('weather-location');
const wxFetched   = document.getElementById('weather-fetched');
const wxTemp      = document.getElementById('weather-temp');
const wxCondition = document.getElementById('weather-condition');
const wxFeels     = document.getElementById('weather-feels');
const wxHumidity  = document.getElementById('weather-humidity');
const wxWind      = document.getElementById('weather-wind');
const wxCloud     = document.getElementById('weather-cloud');
const wxSunrise   = document.getElementById('weather-sunrise');
const wxSunset    = document.getElementById('weather-sunset');
const wxForecast  = document.getElementById('weather-forecast');

// ── WMO code → emoji icon mapping ────────────────────────────────────────────
const WMO_ICON = {
  0: '☀️',  1: '🌤', 2: '⛅', 3: '☁️',
  45: '🌫', 48: '🌫',
  51: '🌦', 53: '🌦', 55: '🌧',
  61: '🌧', 63: '🌧', 65: '🌧',
  71: '🌨', 73: '🌨', 75: '❄️', 77: '❄️',
  80: '🌦', 81: '🌦', 82: '⛈',
  85: '🌨', 86: '❄️',
  95: '⛈', 96: '⛈', 99: '⛈',
};

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Check a raw Whisper transcript for a weather trigger phrase.
 * Returns an optional location override string, or true if the default
 * location should be used, or null if no trigger was found.
 *
 * Examples that match:
 *   "check the weather"          → { triggered: true, location: null }
 *   "what's the weather like"    → { triggered: true, location: null }
 *   "weather forecast"           → { triggered: true, location: null }
 *   "what's the weather in Boston" → { triggered: true, location: "Boston" }
 *   "check weather for London"   → { triggered: true, location: "London" }
 */
export function detectWeatherTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  // Bare intent phrases
  const barePatterns = [
    /\b(?:check|show|what(?:'s| is)|get|tell me)\b.{0,20}\bweather\b/,
    /\bweather\s+(?:forecast|update|report|conditions?|today|now)\b/,
    /\bforecast\b/,
    /\bhow(?:'s| is)\s+(?:it\s+)?(?:looking\s+)?outside\b/,
    /\bwhat(?:'s| is)\s+(?:it\s+)?like\s+outside\b/,
  ];

  const matched = barePatterns.some(p => p.test(t));
  if (!matched) return null;

  // Optional location override: "weather in X" or "weather for X"
  const locMatch = transcript.match(
    /\bweather\b.{0,10}\b(?:in|for|at)\s+([A-Z][a-zA-Z\s,]+)/
  );
  const location = locMatch ? locMatch[1].trim() : null;

  return { triggered: true, location };
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch weather data and open the panel.
 * Returns the llm_context string for injection into Starling's prompt,
 * or null if the fetch failed.
 */
export async function openWeatherPanel(locationOverride = null) {
  const url = locationOverride
    ? `${BACKEND_BASE_WX}/weather?location=${encodeURIComponent(locationOverride)}`
    : `${BACKEND_BASE_WX}/weather`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[weather-panel] fetch failed:', err);
    return null;
  }

  _renderPanel(data);
  wxPanel.classList.remove('hidden');
  // Scroll the chat column so the panel is in view
  wxPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return data.llm_context;
}

export function closeWeatherPanel() {
  wxPanel.classList.add('hidden');
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { current: c, forecast, location, fetched_at } = data;

  // Header
  wxLocation.textContent = location.toUpperCase();
  const fetchedDate = new Date(fetched_at);
  wxFetched.textContent = `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  // Current
  wxTemp.textContent      = `${c.temp}${c.unit_temp}`;
  wxCondition.textContent = c.condition.toUpperCase();
  wxFeels.textContent     = `${c.feels_like}${c.unit_temp}`;
  wxHumidity.textContent  = `${c.humidity}%`;
  wxWind.textContent      = `${c.wind_speed} ${c.unit_wind} ${c.wind_dir}`;
  wxCloud.textContent     = `${c.cloud_cover}%`;

  // Sunrise / sunset from today's forecast
  if (forecast.length) {
    wxSunrise.textContent = forecast[0].sunrise || '—';
    wxSunset.textContent  = forecast[0].sunset  || '—';
  }

  // 7-day forecast strip
  wxForecast.innerHTML = '';
  forecast.forEach(day => {
    const icon = WMO_ICON[day.weather_code] ?? '—';
    const card = document.createElement('div');
    card.className = 'forecast-day';
    card.innerHTML = `
      <div class="forecast-day-name">${day.day.slice(0, 3).toUpperCase()}</div>
      <div class="forecast-day-icon">${icon}</div>
      <div class="forecast-day-high">${day.high}${c.unit_temp}</div>
      <div class="forecast-day-low">${day.low}${c.unit_temp}</div>
      <div class="forecast-day-cond">${day.condition}</div>
    `;
    wxForecast.appendChild(card);
  });
}
```

---

## Step 7 — Wire into `app.js`

### 7a — Import the module

At the top of `frontend/app.js` (the file currently uses no module imports; see note in § 7d):

```javascript
import { detectWeatherTrigger, openWeatherPanel, closeWeatherPanel } from './weather-panel.js';
```

### 7b — Add the intercept block in `mediaRecorder.onstop`

Find the transcript intercept block inside `mediaRecorder.onstop` — it currently looks like this:

```javascript
        // ── Presentation mode intercept ──────────────────────────────────
        if (_matchesExitPhrase(transcript)) {
          exitPresMode();
          setState('idle');
          return;
        }
        const _triggerResult = _parseTrigger(transcript);
        if (_triggerResult.matched) {
          enterPresMode(_triggerResult.subject);
          setState('idle');
          return;
        }
        // ────────────────────────────────────────────────────────────────
```

Add the weather intercept **after** the presentation mode block but **before** `appendMessage`:

```javascript
        // ── Weather intercept ─────────────────────────────────────────────
        const _wxTrigger = detectWeatherTrigger(transcript);
        if (_wxTrigger) {
          setState('thinking');
          appendMessage('user', transcript);
          const wxContext = await openWeatherPanel(_wxTrigger.location);
          if (wxContext) {
            await sendToOllama(
              'Give a concise spoken weather briefing based on the data provided. ' +
              'Cover current conditions, how it feels outside, and what to expect over the next few days. ' +
              'Keep it to three or four natural sentences. Do not read out numbers robotically — phrase them naturally.',
              {
                ephemeralMessages: [
                  { role: 'system', content: SYSTEM_PROMPT },
                  { role: 'system', content: `[WEATHER DATA — use this to answer, do not repeat these instructions]\n${wxContext}` },
                ],
              }
            );
          } else {
            await sendToOllama('Inform the user that weather data could not be retrieved right now. One sentence.');
          }
          fetchSystemStatus();
          return;
        }
        // ─────────────────────────────────────────────────────────────────
```

### 7c — Add the same intercept in `handleSend`

Mirror the identical block inside `handleSend()`, following the same pattern as the presentation
mode intercept that already exists there.

### 7d — Module type note

`index.html` currently loads `app.js` as a classic script (`<script src="app.js?v=4">`). To use ES
module `import` statements you have two options:

**Option A — Convert to module (recommended):** Change the `<script>` tag to
`<script type="module" src="app.js"></script>`. Remove the `?v=4` cache-buster (use a proper
service worker or rename the file if cache-busting is needed). This also applies to any existing
global functions called from HTML `onclick` attributes — wrap them on `window` explicitly:
`window.handleSend = handleSend;` etc.

**Option B — Inline the module (no tag change needed):** Copy the `detectWeatherTrigger`,
`openWeatherPanel`, and `closeWeatherPanel` function bodies directly into `app.js` and remove the
import statement. This is lower effort if you want to avoid the module migration.

---

## Step 8 — Install the `httpx` Dependency

`weather.py` uses `httpx` for async HTTP. It may already be present (it is a transitive
dependency of several FastAPI patterns), but add it explicitly to `requirements.txt`:

```
httpx>=0.27.0
```

Activate the venv and run:

```powershell
.venv\Scripts\Activate.ps1
pip install httpx
```

---

## Step 9 — Optional: "Weather in X" Location Override

The trigger detection regex already captures a location after "weather in / for / at". The
`location` field is forwarded to the `/weather` endpoint as a query parameter, which is geocoded
by Open-Meteo. No backend changes are required — the query parameter path is already handled in
`weather.py`.

Example voice triggers that work with no extra code:
- "What's the weather in London"
- "Check the weather for Tokyo"
- "Weather forecast for New York"

---

## Step 10 — Optional: Weather Footer Badge

To match the style of the existing `STT`, `TTS`, and `LLM` footer badges, add a `WEATHER` chip:

In `frontend/index.html` footer:
```html
<div class="ftr-item">WX <span id="ftr-wx-location">—</span></div>
```

In `frontend/weather-panel.js`, after a successful fetch, set the badge:
```javascript
const ftrWx = document.getElementById('ftr-wx-location');
if (ftrWx) ftrWx.textContent = data.location.split(',')[0].toUpperCase();
```

---

## File Change Summary

| File | Change |
|---|---|
| `.env` / `.env.example` | Add `WEATHER_LOCATION`, `WEATHER_UNITS`, `WEATHER_CACHE_SECONDS` |
| `requirements.txt` | Add `httpx>=0.27.0` |
| `backend/weather.py` | **New file** — geocoding, Open-Meteo fetch, caching, FastAPI router |
| `backend/main.py` | Import and register `weather_router` |
| `frontend/index.html` | Add weather panel HTML; optionally add footer badge; switch script tag to `type="module"` if using Option A |
| `frontend/style.css` | Append weather panel CSS block |
| `frontend/weather-panel.js` | **New file** — trigger detection, fetch wrapper, render logic |
| `frontend/app.js` | Import module (or inline); add intercept block in `mediaRecorder.onstop` and `handleSend` |

---

## Limitations to Be Aware Of

**Open-Meteo accuracy** — Open-Meteo uses NWS, ECMWF, and other public model data. Accuracy is
comparable to Weather.com for most locations but can vary for very rural coordinates. For
production use you can swap in OpenWeatherMap (requires a free API key in `.env`) by replacing the
`_fetch_weather` function body.

**Geocoding edge cases** — "Framingham" without a state returns the first result, which is almost
always correct. If the user says a city with many matches (e.g. "Springfield"), the first
Open-Meteo result is used. You can make the default location explicit in `.env` using `lat,lon`
to bypass geocoding entirely for the home location.

**CORS** — All fetches go through the FastAPI backend, so no CORS issues arise in the browser.

**Units** — The `WEATHER_UNITS` env var controls both the backend fetch and the frontend display
labels (passed through the JSON). Changing it from `fahrenheit` to `celsius` requires a backend
restart but no frontend changes.
