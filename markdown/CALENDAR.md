# Calendar Integration — Implementation Guide

Adds a voice-triggered calendar panel that reads the user's Google Calendar (or Apple Calendar via
CalDAV), displays a structured daily and weekly event view inside the S.T.A.R.L.I.N.G. UI, and
injects a structured summary of the day's schedule into the LLM context so Starling can deliver a
spoken briefing — "What's on my schedule today?" — in natural prose.

---

## Overview

```
Microphone → Whisper STT → [intercept transcript] → /calendar (FastAPI)
                                    ↓                      ↓
                           open calendar panel      Google Calendar API
                                    ↓                   (or CalDAV)
                           render event list ← structured events JSON
                                    ↓
                           sendToOllama() with schedule context injected
                                    ↓
                           Kokoro TTS spoken briefing
```

Two backends are supported: **Google Calendar** (OAuth2, recommended — richest API) and
**Apple iCloud Calendar** (CalDAV — no Google account required). Both share the same FastAPI
endpoint and frontend panel. Only one needs to be configured.

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| Calendar provider | Google Calendar API v3 | Most robust Python SDK; free for personal use; works on Windows without macOS |
| Apple fallback | CalDAV via `caldav` Python library | No Google account needed; works with iCloud, Nextcloud, Fastmail |
| Auth (Google) | OAuth2 Device Flow or installed-app flow | Avoids needing a web redirect URI; credentials stored in `~/.starling/google_token.json` |
| Auth (Apple) | App-specific password in `.env` | CalDAV uses Basic Auth with an app-specific password — no OAuth needed |
| Scope (Google) | `calendar.readonly` | Least-privilege — Starling only reads, never writes |
| Time window | Today (midnight → 23:59) + next 7 days | Matches the weather panel's 7-day horizon |
| Caching | 5-minute in-memory cache | Prevents redundant API calls if user asks multiple times |
| Backend vs. frontend | Backend (`calendar.py`) | Keeps OAuth credentials server-side; frontend never sees tokens |

---

## Part A — Google Calendar

### A1 — Create a Google Cloud Project and OAuth Credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Create a new project (e.g. `starling-local`).
3. Navigate to **APIs & Services → Library**, search for **Google Calendar API**, and enable it.
4. Navigate to **APIs & Services → OAuth consent screen**:
   - Select **External** user type.
   - Fill in App name (`STARLING Local`) and your email.
   - Add scope: `https://www.googleapis.com/auth/calendar.readonly`
   - Add yourself as a **Test user** (required while the app is in testing mode).
5. Navigate to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Name: `STARLING Desktop`
   - Download the JSON file and save it as `credentials/google_calendar_credentials.json` in the
     repo root. **Do not commit this file** — add `credentials/` to `.gitignore`.

### A2 — Add `.env` Variables for Google

```
# ── Calendar (Google) ─────────────────────────────────────────────────────────
CALENDAR_BACKEND=google
GOOGLE_CREDENTIALS_FILE=credentials/google_calendar_credentials.json
GOOGLE_TOKEN_FILE=credentials/google_token.json
CALENDAR_TIMEZONE=America/New_York     # IANA timezone — used for "today" window
CALENDAR_LOOKAHEAD_DAYS=7
CALENDAR_CACHE_SECONDS=300
```

### A3 — Install Python Dependencies

```powershell
.venv\Scripts\Activate.ps1
pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib
```

Add to `requirements.txt`:

```
google-api-python-client>=2.130.0
google-auth-httplib2>=0.2.0
google-auth-oauthlib>=1.2.0
```

### A4 — First-Time Authentication (One-Shot)

Google Calendar uses OAuth2 with a browser consent flow. On first use the backend will open a
browser window for the user to authorise access. After authorisation the token is stored locally
at `GOOGLE_TOKEN_FILE` and reused silently on every subsequent request — no browser prompt needed
again unless the token expires (rare for offline access tokens).

The backend handles this automatically in `calendar.py` (see Step B). To run the authorisation
manually before the server starts, a helper script is provided (see Step A5).

### A5 — One-Shot Auth Script

Create `scripts/auth_google_calendar.py`:

```python
"""
Run this once to authorise Google Calendar access and cache the token.
Usage:  python scripts/auth_google_calendar.py
"""
import os
from pathlib import Path
from dotenv import load_dotenv
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials

load_dotenv()

SCOPES      = ["https://www.googleapis.com/auth/calendar.readonly"]
CREDS_FILE  = Path(os.getenv("GOOGLE_CREDENTIALS_FILE", "credentials/google_calendar_credentials.json"))
TOKEN_FILE  = Path(os.getenv("GOOGLE_TOKEN_FILE", "credentials/google_token.json"))

flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
creds = flow.run_local_server(port=0)

TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
TOKEN_FILE.write_text(creds.to_json())
print(f"Token saved to {TOKEN_FILE}")
```

Run it once:
```powershell
.venv\Scripts\python.exe scripts/auth_google_calendar.py
```

---

## Part B — Apple Calendar (CalDAV alternative)

If you use iCloud Calendar (or any CalDAV server — Nextcloud, Fastmail, etc.) instead of Google,
skip Part A entirely and use this section.

### B1 — Create an Apple App-Specific Password

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. Under **Security → App-Specific Passwords**, generate a new password.
3. Label it `STARLING`.

### B2 — Add `.env` Variables for Apple

```
# ── Calendar (Apple / CalDAV) ─────────────────────────────────────────────────
CALENDAR_BACKEND=caldav
CALDAV_URL=https://caldav.icloud.com
CALDAV_USERNAME=your.apple.id@icloud.com
CALDAV_PASSWORD=xxxx-xxxx-xxxx-xxxx   # app-specific password
CALENDAR_TIMEZONE=America/New_York
CALENDAR_LOOKAHEAD_DAYS=7
CALENDAR_CACHE_SECONDS=300
```

For **Nextcloud** or **Fastmail**, replace `CALDAV_URL` with your server's CalDAV URL
(e.g. `https://nextcloud.yourdomain.com/remote.php/dav/`).

### B3 — Install Python Dependencies

```powershell
.venv\Scripts\Activate.ps1
pip install caldav icalendar
```

Add to `requirements.txt`:

```
caldav>=1.3.9
icalendar>=5.0.13
```

---

## Step C — Create `backend/calendar.py`

Create a new file `backend/calendar.py`. The file contains a unified FastAPI router that delegates
to either the Google or CalDAV backend based on `CALENDAR_BACKEND`.

```python
"""
backend/calendar.py
Calendar data fetching — supports Google Calendar API and CalDAV (iCloud, Nextcloud, etc.).
Exposes GET /calendar and GET /calendar/week endpoints.
"""

import os
import time
from datetime import datetime, timedelta, time as dt_time
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_BACKEND        = os.getenv("CALENDAR_BACKEND", "google").lower()
_TZ_NAME        = os.getenv("CALENDAR_TIMEZONE", "America/New_York")
_LOOKAHEAD      = int(os.getenv("CALENDAR_LOOKAHEAD_DAYS", "7"))
_CACHE_SECONDS  = int(os.getenv("CALENDAR_CACHE_SECONDS", "300"))

# Google-specific
_CREDS_FILE = Path(os.getenv("GOOGLE_CREDENTIALS_FILE", "credentials/google_calendar_credentials.json"))
_TOKEN_FILE = Path(os.getenv("GOOGLE_TOKEN_FILE", "credentials/google_token.json"))
_SCOPES     = ["https://www.googleapis.com/auth/calendar.readonly"]

# CalDAV-specific
_CALDAV_URL  = os.getenv("CALDAV_URL", "")
_CALDAV_USER = os.getenv("CALDAV_USERNAME", "")
_CALDAV_PASS = os.getenv("CALDAV_PASSWORD", "")

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _tz() -> ZoneInfo:
    return ZoneInfo(_TZ_NAME)


def _day_window(offset_days: int = 0) -> tuple[datetime, datetime]:
    """Return (start_of_day, end_of_day) for today + offset_days, in local tz."""
    tz   = _tz()
    base = datetime.now(tz).date() + timedelta(days=offset_days)
    start = datetime.combine(base, dt_time.min, tzinfo=tz)
    end   = datetime.combine(base, dt_time.max, tzinfo=tz)
    return start, end


def _week_window() -> tuple[datetime, datetime]:
    """Return (start_of_today, end_of_day + LOOKAHEAD days)."""
    start, _ = _day_window(0)
    _, end   = _day_window(_LOOKAHEAD)
    return start, end


def _format_event_time(dt_val, all_day: bool) -> str:
    if all_day:
        return "All day"
    tz = _tz()
    if dt_val.tzinfo is None:
        dt_val = dt_val.replace(tzinfo=tz)
    local = dt_val.astimezone(tz)
    return local.strftime("%-I:%M %p").lstrip("0") if os.name != "nt" else local.strftime("%I:%M %p").lstrip("0")


def _build_llm_context(events_today: list, events_week: list, today_label: str) -> str:
    """Build a plain-prose context block for LLM injection."""
    tz = _tz()
    now = datetime.now(tz)

    if not events_today:
        today_summary = f"You have no events scheduled for today, {today_label}."
    else:
        parts = []
        for e in events_today:
            t = e["time"] if e["time"] != "All day" else "all day"
            parts.append(f"{t}: {e['title']}")
            if e.get("location"):
                parts[-1] += f" at {e['location']}"
        today_summary = (
            f"Today is {today_label}. You have {len(events_today)} event"
            f"{'s' if len(events_today) != 1 else ''} scheduled: "
            + "; ".join(parts) + "."
        )

    upcoming = [e for e in events_week if e["date"] != today_label]
    if upcoming:
        by_day: dict = {}
        for e in upcoming:
            by_day.setdefault(e["day"], []).append(e["title"])
        week_summary = "Later this week: " + "; ".join(
            f"{day} — {', '.join(titles)}" for day, titles in list(by_day.items())[:5]
        ) + "."
    else:
        week_summary = "Nothing else scheduled for the rest of the week."

    return f"[CALENDAR CONTEXT — {now.strftime('%A, %B %-d')} at {now.strftime('%-I:%M %p')} {_TZ_NAME}]\n{today_summary} {week_summary}"


# ── Google Calendar backend ───────────────────────────────────────────────────

def _get_google_service():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    creds = None
    if _TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(_TOKEN_FILE), _SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            _TOKEN_FILE.write_text(creds.to_json())
        else:
            raise HTTPException(
                status_code=401,
                detail=(
                    "Google Calendar not authorised. "
                    "Run: python scripts/auth_google_calendar.py"
                ),
            )

    return build("calendar", "v3", credentials=creds)


async def _fetch_google(start: datetime, end: datetime) -> list[dict]:
    import asyncio
    from functools import partial

    service = _get_google_service()

    def _call():
        return (
            service.events()
            .list(
                calendarId="primary",
                timeMin=start.isoformat(),
                timeMax=end.isoformat(),
                singleEvents=True,
                orderBy="startTime",
                maxResults=50,
            )
            .execute()
        )

    # Run sync SDK call in a thread pool to avoid blocking the event loop
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _call)

    events = []
    for item in result.get("items", []):
        start_raw = item["start"].get("dateTime") or item["start"].get("date")
        end_raw   = item["end"].get("dateTime")   or item["end"].get("date")
        all_day   = "dateTime" not in item["start"]

        if all_day:
            from datetime import date
            dt = datetime.fromisoformat(start_raw).replace(tzinfo=_tz())
        else:
            dt = datetime.fromisoformat(start_raw)

        events.append({
            "id":       item["id"],
            "title":    item.get("summary", "(No title)"),
            "time":     _format_event_time(dt, all_day),
            "all_day":  all_day,
            "date":     dt.astimezone(_tz()).strftime("%Y-%m-%d"),
            "day":      dt.astimezone(_tz()).strftime("%A"),
            "location": item.get("location", ""),
            "description": item.get("description", ""),
            "calendar": "primary",
            "color":    item.get("colorId", ""),
        })
    return events


# ── CalDAV backend ─────────────────────────────────────────────────────────────

async def _fetch_caldav(start: datetime, end: datetime) -> list[dict]:
    import asyncio
    from functools import partial

    def _call():
        import caldav
        from icalendar import Calendar as iCal

        client  = caldav.DAVClient(url=_CALDAV_URL, username=_CALDAV_USER, password=_CALDAV_PASS)
        principal = client.principal()
        events  = []

        for calendar in principal.calendars():
            try:
                cal_events = calendar.date_search(start=start, end=end, expand=True)
            except Exception:
                continue
            for vevent in cal_events:
                comp = iCal.from_ical(vevent.data)
                for component in comp.walk():
                    if component.name != "VEVENT":
                        continue
                    dtstart = component.get("DTSTART")
                    if dtstart is None:
                        continue
                    dt = dtstart.dt
                    all_day = not hasattr(dt, "hour")
                    if all_day:
                        from datetime import date as date_type
                        dt = datetime.combine(dt, dt_time.min, tzinfo=_tz())
                    elif dt.tzinfo is None:
                        dt = dt.replace(tzinfo=_tz())
                    dt = dt.astimezone(_tz())

                    events.append({
                        "id":       str(component.get("UID", "")),
                        "title":    str(component.get("SUMMARY", "(No title)")),
                        "time":     _format_event_time(dt, all_day),
                        "all_day":  all_day,
                        "date":     dt.strftime("%Y-%m-%d"),
                        "day":      dt.strftime("%A"),
                        "location": str(component.get("LOCATION", "")),
                        "description": str(component.get("DESCRIPTION", "")),
                        "calendar": str(calendar.name),
                        "color":    "",
                    })
        events.sort(key=lambda e: (e["date"], e["time"]))
        return events

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _call)


# ── Shared fetch dispatcher ───────────────────────────────────────────────────

async def _fetch_events(start: datetime, end: datetime) -> list[dict]:
    if _BACKEND == "google":
        return await _fetch_google(start, end)
    elif _BACKEND == "caldav":
        return await _fetch_caldav(start, end)
    else:
        raise HTTPException(status_code=500, detail=f"Unknown CALENDAR_BACKEND: {_BACKEND}")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/calendar")
async def get_calendar_today():
    """
    Return today's events plus a 7-day forward window.
    Cached for CALENDAR_CACHE_SECONDS.
    """
    tz     = _tz()
    today  = datetime.now(tz).strftime("%Y-%m-%d")
    cache_key = f"cal_{today}"

    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

    today_start, today_end = _day_window(0)
    week_start,  week_end  = _week_window()

    today_events = await _fetch_events(today_start, today_end)
    week_events  = await _fetch_events(week_start, week_end)

    today_label  = datetime.now(tz).strftime("%A, %B %-d") if os.name != "nt" else datetime.now(tz).strftime("%A, %B %d").replace(" 0", " ")
    llm_context  = _build_llm_context(today_events, week_events, today_label)

    data = {
        "today":       today_events,
        "week":        week_events,
        "today_label": today_label,
        "timezone":    _TZ_NAME,
        "llm_context": llm_context,
        "backend":     _BACKEND,
    }

    _cache[cache_key] = {"ts": time.time(), "data": data}
    return data


@router.delete("/calendar/cache")
async def bust_calendar_cache():
    """Force-clear the calendar cache — useful after creating a new event."""
    _cache.clear()
    return {"status": "cleared"}
```

---

## Step D — Register the Router in `backend/main.py`

In `backend/main.py`, alongside the other router imports:

```python
from calendar import router as calendar_router
app.include_router(calendar_router)
```

> **Note:** Python's standard library has a `calendar` module. To avoid a naming collision, either
> rename the file to `gcalendar.py` (and update the import accordingly) or use an explicit relative
> import:
> ```python
> import importlib, sys
> _cal_mod = importlib.import_module('calendar_routes')  # if you rename to calendar_routes.py
> app.include_router(_cal_mod.router)
> ```
> The simplest fix is to name the file `calendar_routes.py` instead of `calendar.py`.

---

## Step E — Add the Calendar Panel HTML

In `frontend/index.html`, add the calendar panel markup inside `.starling`, placed alongside (or
below) the weather panel:

```html
<!-- Calendar Panel — hidden until calendar mode is active -->
<div class="cal-panel hidden" id="cal-panel">
  <div class="cal-header">
    <div class="cal-today-label" id="cal-today-label">—</div>
    <div class="cal-tz" id="cal-tz">—</div>
  </div>

  <!-- Today's event list -->
  <div class="cal-section-title">TODAY</div>
  <div class="cal-event-list" id="cal-today-list">
    <div class="cal-empty">No events scheduled.</div>
  </div>

  <!-- This week's events (collapsible) -->
  <div class="cal-section-title cal-week-toggle" id="cal-week-toggle">
    THIS WEEK <span id="cal-week-chevron">▸</span>
  </div>
  <div class="cal-event-list cal-week-list hidden" id="cal-week-list"></div>
</div>
```

---

## Step F — Add the CSS

Append to `frontend/style.css`:

```css
/* ── Calendar Panel ──────────────────────────────────────────────────────────── */

.cal-panel {
  width: 100%;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 16px 20px 14px;
  margin-top: 12px;
  animation: weatherFadeIn 0.35s ease;  /* reuses the same keyframe as weather panel */
}

.cal-panel.hidden {
  display: none;
}

.cal-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 8px;
}

.cal-today-label {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.75rem, 1.4vw, 0.95rem);
  color: #e0e0e0;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.cal-tz {
  font-size: 0.6rem;
  color: #555;
  letter-spacing: 0.08em;
}

.cal-section-title {
  font-size: 0.6rem;
  color: #555;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin: 12px 0 6px;
}

.cal-week-toggle {
  cursor: pointer;
  user-select: none;
  display: flex;
  gap: 6px;
  align-items: center;
}

.cal-week-toggle:hover {
  color: #888;
}

.cal-event-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cal-event-list.hidden {
  display: none;
}

.cal-empty {
  font-size: 0.7rem;
  color: #444;
  padding: 4px 0;
}

.cal-event {
  display: grid;
  grid-template-columns: 80px 1fr;
  column-gap: 12px;
  align-items: start;
  padding: 7px 10px;
  background: rgba(255, 255, 255, 0.025);
  border-radius: 6px;
  border-left: 2px solid rgba(255, 255, 255, 0.1);
}

.cal-event-time {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.7rem;
  color: #888;
  white-space: nowrap;
}

.cal-event-title {
  font-size: 0.78rem;
  color: #ddd;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cal-event-location {
  font-size: 0.65rem;
  color: #555;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  grid-column: 2;
}

.cal-event-day-label {
  font-size: 0.6rem;
  color: #555;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-top: 8px;
  margin-bottom: 2px;
  padding-left: 2px;
}
```

---

## Step G — Create `frontend/calendar-panel.js`

```javascript
// frontend/calendar-panel.js
// Calendar panel: trigger detection, data fetch, render, and LLM context export.

const BACKEND_BASE_CAL = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const calPanel       = document.getElementById('cal-panel');
const calTodayLabel  = document.getElementById('cal-today-label');
const calTz          = document.getElementById('cal-tz');
const calTodayList   = document.getElementById('cal-today-list');
const calWeekList    = document.getElementById('cal-week-list');
const calWeekToggle  = document.getElementById('cal-week-toggle');
const calWeekChevron = document.getElementById('cal-week-chevron');

// ── Collapsible week section ──────────────────────────────────────────────────
calWeekToggle?.addEventListener('click', () => {
  const hidden = calWeekList.classList.toggle('hidden');
  calWeekChevron.textContent = hidden ? '▸' : '▾';
});

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Check a Whisper transcript for a calendar / schedule trigger.
 * Returns true if matched, null if not.
 *
 * Examples that match:
 *   "what's on my schedule"
 *   "check my calendar"
 *   "what do I have today"
 *   "show me my agenda"
 *   "any meetings today"
 *   "what's happening this week"
 */
export function detectCalendarTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  const patterns = [
    /\b(?:check|show|open|view|what(?:'s| is| are)|pull up)\b.{0,25}\b(?:calendar|schedule|agenda|events?|meetings?|appointments?)\b/,
    /\bwhat(?:'s| is)\s+(?:on\s+)?(?:my\s+)?(?:schedule|calendar|agenda|plate)\b/,
    /\bdo\s+i\s+have\s+(?:any\s+)?(?:meetings?|events?|appointments?|calls?)\b/,
    /\b(?:any|got any)\s+(?:meetings?|events?|appointments?|calls?)\s+today\b/,
    /\bwhat(?:'s| is)\s+(?:on\s+)?(?:today|this\s+week|tomorrow)\b/,
    /\bmy\s+(?:day|week|schedule|agenda|calendar)\b/,
  ];

  return patterns.some(p => p.test(t)) ? true : null;
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch calendar data and open the panel.
 * Returns the llm_context string for LLM injection, or null on failure.
 */
export async function openCalendarPanel() {
  let data;
  try {
    const res = await fetch(`${BACKEND_BASE_CAL}/calendar`);
    if (!res.ok) throw new Error(`Calendar API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[calendar-panel] fetch failed:', err);
    return null;
  }

  _renderPanel(data);
  calPanel.classList.remove('hidden');
  calPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return data.llm_context;
}

export function closeCalendarPanel() {
  calPanel.classList.add('hidden');
}

// ── Render ─────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { today, week, today_label, timezone } = data;

  // Header
  calTodayLabel.textContent = today_label.toUpperCase();
  calTz.textContent         = timezone;

  // Today's events
  calTodayList.innerHTML = '';
  if (!today.length) {
    calTodayList.innerHTML = '<div class="cal-empty">No events today.</div>';
  } else {
    today.forEach(e => calTodayList.appendChild(_makeEventRow(e)));
  }

  // Week events (grouped by day, excluding today)
  calWeekList.innerHTML = '';
  const todayDate = today_label; // used as label comparison
  const byDay = new Map();
  for (const e of week) {
    if (today.some(t => t.date === e.date)) continue; // skip today's events
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }

  if (!byDay.size) {
    calWeekList.innerHTML = '<div class="cal-empty">Nothing else this week.</div>';
  } else {
    for (const [day, events] of byDay) {
      const dayLabel = document.createElement('div');
      dayLabel.className = 'cal-event-day-label';
      dayLabel.textContent = day.toUpperCase();
      calWeekList.appendChild(dayLabel);
      events.forEach(e => calWeekList.appendChild(_makeEventRow(e)));
    }
  }
}

function _makeEventRow(event) {
  const row = document.createElement('div');
  row.className = 'cal-event';
  row.innerHTML = `
    <div class="cal-event-time">${event.time}</div>
    <div class="cal-event-title">${_escHtml(event.title)}</div>
    ${event.location ? `<div class="cal-event-location">📍 ${_escHtml(event.location)}</div>` : ''}
  `;
  return row;
}

function _escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

---

## Step H — Wire into `app.js`

### H1 — Import the module

```javascript
import { detectCalendarTrigger, openCalendarPanel, closeCalendarPanel } from './calendar-panel.js';
```

### H2 — Add the intercept block in `mediaRecorder.onstop`

Add the calendar intercept immediately after the weather intercept (or after the presentation mode
intercept if weather is not implemented yet), following the same `return` pattern:

```javascript
        // ── Calendar intercept ────────────────────────────────────────────
        if (detectCalendarTrigger(transcript)) {
          setState('thinking');
          appendMessage('user', transcript);
          const calContext = await openCalendarPanel();
          if (calContext) {
            await sendToOllama(
              'Give a concise spoken summary of the schedule shown. ' +
              'Start with what is happening today, then briefly mention anything notable later this week. ' +
              'Phrase times naturally — say "two-thirty PM" not "14:30". ' +
              'Keep it to three or four sentences. Do not list every event robotically.',
              {
                ephemeralMessages: [
                  { role: 'system', content: SYSTEM_PROMPT },
                  { role: 'system', content: calContext },
                ],
              }
            );
          } else {
            await sendToOllama(
              'Inform the user that the calendar could not be reached. ' +
              'Mention they may need to run the authorisation script if using Google Calendar. One sentence.'
            );
          }
          fetchSystemStatus();
          return;
        }
        // ─────────────────────────────────────────────────────────────────
```

### H3 — Mirror in `handleSend`

Add the identical block inside `handleSend()` following the same pattern as the presentation mode
intercept already there.

---

## Step I — Authorisation Error Surface in the UI

If the Google token is missing or expired, the `/calendar` endpoint returns HTTP 401. The
`openCalendarPanel()` function catches this and returns `null`, which triggers the fallback
`sendToOllama` message instructing the user to run the auth script. This is the only user-facing
error surface needed for a local personal tool — no popup or modal is required.

For a more polished experience, you could detect the 401 specifically:

```javascript
const res = await fetch(`${BACKEND_BASE_CAL}/calendar`);
if (res.status === 401) {
  return '__AUTH_REQUIRED__';  // sentinel string
}
```

Then in `app.js`:
```javascript
if (calContext === '__AUTH_REQUIRED__') {
  appendMessage('assistant', 'Google Calendar not authorised. Run: python scripts/auth_google_calendar.py');
  setState('idle');
  return;
}
```

---

## Step J — Optional: "Refresh Calendar" Voice Command

Add a trigger that forces a cache clear and re-fetch:

```javascript
// In detectCalendarTrigger, add:
/\b(?:refresh|update|sync)\s+(?:my\s+)?(?:calendar|schedule)\b/
```

And in the intercept block, call `DELETE /calendar/cache` before `openCalendarPanel()`:

```javascript
if (transcript.toLowerCase().includes('refresh') || transcript.toLowerCase().includes('sync')) {
  await fetch(`${BACKEND_BASE}/calendar/cache`, { method: 'DELETE' });
}
```

---

## Step K — Optional: Calendar Footer Badge

Match the pattern of the existing footer badges. In `index.html`:

```html
<div class="ftr-item">CAL <span id="ftr-cal-backend">—</span></div>
```

In `calendar-panel.js`, after a successful fetch:
```javascript
const ftrCal = document.getElementById('ftr-cal-backend');
if (ftrCal) ftrCal.textContent = data.backend.toUpperCase();  // "GOOGLE" or "CALDAV"
```

---

## File Change Summary

| File | Change |
|---|---|
| `.env` / `.env.example` | Add `CALENDAR_BACKEND`, `GOOGLE_CREDENTIALS_FILE`, `GOOGLE_TOKEN_FILE`, `CALENDAR_TIMEZONE`, `CALENDAR_LOOKAHEAD_DAYS`, `CALENDAR_CACHE_SECONDS` (plus CalDAV vars if applicable) |
| `requirements.txt` | Add `google-api-python-client`, `google-auth-httplib2`, `google-auth-oauthlib` (Google) **or** `caldav`, `icalendar` (Apple) |
| `backend/calendar_routes.py` | **New file** — event fetching, caching, LLM context builder, FastAPI router |
| `backend/main.py` | Import and register `calendar_router` |
| `frontend/index.html` | Add calendar panel HTML; optionally add footer badge |
| `frontend/style.css` | Append calendar panel CSS block |
| `frontend/calendar-panel.js` | **New file** — trigger detection, fetch wrapper, render logic |
| `frontend/app.js` | Import module (or inline); add intercept block in `mediaRecorder.onstop` and `handleSend` |
| `scripts/auth_google_calendar.py` | **New file** — one-shot OAuth2 authorisation helper (Google only) |
| `credentials/` (folder) | Create folder; add to `.gitignore`; store `google_calendar_credentials.json` here |

---

## Limitations to Be Aware Of

**Google OAuth consent screen** — While the app is in "Testing" mode, the OAuth token expires after
7 days. Publish the consent screen to "Production" (no review needed for personal-use scopes in
`calendar.readonly`) and the token becomes a persistent offline refresh token that auto-renews.

**iCloud CalDAV reliability** — Apple's CalDAV endpoint occasionally returns 503 or timeouts.
The 5-minute cache mitigates this — if the first call fails, the error is surfaced to the user
immediately. Retries are not implemented; the user can say "check my calendar" again.

**Windows timezone names** — Python 3.9+ `zoneinfo` uses IANA timezone names (e.g.
`America/New_York`). These work natively on Windows from Python 3.9+ with `tzdata` installed.
Add `tzdata` to `requirements.txt` if users report timezone errors:
```
tzdata>=2024.1
```

**`calendar` naming collision** — Python's standard library includes a `calendar` module. Name
the backend file `calendar_routes.py` to avoid shadowing it, and update the import in `main.py`
accordingly.

**Private / work calendars** — The Google API returns events from the `primary` calendar only.
To include shared or work calendars, list all calendars with `service.calendarList().list()` and
iterate over multiple `calendarId` values. This is a minor addition to `_fetch_google()`.
