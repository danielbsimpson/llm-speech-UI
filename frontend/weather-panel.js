// frontend/weather-panel.js
// Weather panel: trigger detection, data fetch, render, and LLM context export.

const BACKEND_BASE_WX = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const _starlingEl = document.getElementById('starling');
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
const ftrWxBadge  = document.getElementById('ftr-wx-location');

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

// ── Auto-dismiss ─────────────────────────────────────────────────────────────
let _autoDismissTimer = null;

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Check a raw Whisper transcript for a weather trigger phrase.
 * Returns { triggered: true, location: string|null } if matched, or null if not.
 *
 * Examples:
 *   "check the weather"            → { triggered: true, location: null }
 *   "what's the weather in Boston" → { triggered: true, location: "Boston" }
 *   "forecast for London"          → { triggered: true, location: "London" }
 */
export function detectWeatherTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

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
  _starlingEl.classList.add('weather-mode');
  wxPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Update footer badge
  if (ftrWxBadge) ftrWxBadge.textContent = data.location.split(',')[0].toUpperCase();

  // Auto-dismiss after 30 seconds if no other action clears it first
  clearTimeout(_autoDismissTimer);
  _autoDismissTimer = setTimeout(closeWeatherPanel, 30_000);

  // Append retrieval time to the LLM context so the model knows when the data was fetched
  const fetchedDate = new Date(data.fetched_at);
  const timeStr = fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${data.llm_context} [Weather data retrieved at ${timeStr} local time.]`;
}

export function closeWeatherPanel() {
  clearTimeout(_autoDismissTimer);
  _autoDismissTimer = null;
  _starlingEl.classList.remove('weather-mode');
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
