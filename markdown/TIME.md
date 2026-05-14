# Time — Implementation Guide

Adds a voice-triggered time query that activates on phrases like *"can you tell me the time"* or
*"what time is it"*. Unlike every other panel in the system, **this requires zero backend calls and
zero LLM involvement** — the current time is read from `Date()` in the browser at the instant the
trigger fires, formatted into natural prose, appended to the chat, and sent straight to Kokoro TTS
via `enqueueSpeak`. The response is audible in under 200 ms from trigger detection.

An optional LLM path is documented for cases where you want Starling to phrase the time more
conversationally (e.g. *"It's just gone half past two in the afternoon"*), at the cost of the
usual LLM round-trip latency.

---

## Overview

```
Microphone → Whisper STT → [intercept transcript]
                                    ↓
                           detectTimeTrigger()
                                    ↓
                        format time with Date() (browser)
                                    ↓
                        appendMessage() + enqueueSpeak()
                                    ↓
                        Kokoro TTS — spoken immediately
                        (no /chat request, no LLM wait)
```

No new files are required. The entire implementation is a single function added to `app.js` and
wired into the two existing intercept blocks.

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| Time source | Browser `Date()` | No API, no backend, always accurate, zero latency |
| LLM involvement | **None** (direct speak) | Time is a deterministic single-fact answer — the LLM adds latency with no value |
| LLM opt-in | Optional `sendToOllama` path documented | Available if you prefer natural-language phrasing over templated output |
| `_buildBootContext()` time stamp | Not used for this trigger | Boot context bakes the time at page load; `Date()` at trigger time is always fresh and exact |
| Display | Chat bubble + optional small clock panel | Clock panel shows date, time, and timezone; fades after 30 s or on next interaction |

---

## Note on `_buildBootContext()`

The existing `_buildBootContext()` function (line ~203 of `app.js`) already injects the current
date and time into the system prompt at page load:

```javascript
const date = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
```

This means the LLM already *knows* the time — but that snapshot is fixed at page load. For a
session that has been open for several hours, the LLM's concept of "now" drifts. The direct
`Date()` approach in this guide always reflects the exact moment of the query.

---

## Step 1 — Add the Clock Panel HTML

In `frontend/index.html`, inside `.starling` alongside the other panels (weather, calendar, etc.):

```html
<!-- Clock Panel — fades in briefly on time query, auto-dismisses -->
<div class="clock-panel hidden" id="clock-panel">
  <div class="clock-time" id="clock-time">—</div>
  <div class="clock-detail">
    <span class="clock-date" id="clock-date">—</span>
    <span class="clock-tz"   id="clock-tz">—</span>
  </div>
</div>
```

---

## Step 2 — Add the CSS

Append to `frontend/style.css`:

```css
/* ── Clock Panel ──────────────────────────────────────────────────────────────── */

.clock-panel {
  width: 100%;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 16px 24px;
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: weatherFadeIn 0.3s ease;   /* reuses existing keyframe */
}

.clock-panel.hidden {
  display: none;
}

/* Auto-dismiss: fade out after the panel's --dismiss-delay (set via JS) */
.clock-panel.dismissing {
  animation: clockFadeOut 0.8s ease forwards;
}

@keyframes clockFadeOut {
  from { opacity: 1; }
  to   { opacity: 0; pointer-events: none; }
}

.clock-time {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(2.2rem, 6vw, 3.8rem);
  color: #ffffff;
  letter-spacing: 0.04em;
  line-height: 1;
}

.clock-detail {
  display: flex;
  gap: 16px;
  align-items: baseline;
}

.clock-date {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.7rem, 1.5vw, 0.9rem);
  color: #aaa;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.clock-tz {
  font-size: 0.62rem;
  color: #555;
  letter-spacing: 0.08em;
}
```

---

## Step 3 — Add Time Logic to `app.js`

No new file is needed. Add the following block to `app.js` alongside the other feature functions
(e.g. near the `detectWeatherTrigger` block, or grouped with the other trigger functions at the
top of the file):

```javascript
// ── Time query ────────────────────────────────────────────────────────────────

// DOM refs for the clock panel
const clockPanel = document.getElementById('clock-panel');
const clockTime  = document.getElementById('clock-time');
const clockDate  = document.getElementById('clock-date');
const clockTz    = document.getElementById('clock-tz');
let   _clockDismissTimer = null;

/**
 * Detect a time query in a Whisper transcript.
 * Returns true if matched, null otherwise.
 *
 * Activation phrases:
 *   "what time is it"
 *   "can you tell me the time"
 *   "what's the time"
 *   "do you know what time it is"
 *   "current time"
 *   "tell me the time"
 */
function detectTimeTrigger(transcript) {
  const t = transcript.trim().toLowerCase();
  const patterns = [
    /\bwhat(?:'s| is)\s+the\s+time\b/,
    /\bwhat\s+time\s+is\s+it\b/,
    /\btell\s+me\s+the\s+time\b/,
    /\bdo\s+you\s+know\s+(?:what\s+)?the\s+time\b/,
    /\bcurrent\s+time\b/,
    /\bcan\s+you\s+(?:tell\s+me\s+)?the\s+time\b/,
    /\btime\s+(?:please|now)\b/,
    /\bwhat\s+time\s+(?:is\s+it\s+)?(?:right\s+now|now)\b/,
    /\bhow\s+late\s+is\s+it\b/,
  ];
  return patterns.some(p => p.test(t)) ? true : null;
}

/**
 * Format the current time into a natural spoken phrase.
 * Examples:
 *   "It's 9:05 in the morning."
 *   "It's 2:34 in the afternoon."
 *   "It's 11:58 at night."
 */
function _formatTimeSpoken(now) {
  const h   = now.getHours();
  const m   = now.getMinutes();
  const min = m === 0   ? 'on the hour'
            : m < 10   ? `oh ${m}`
            : String(m);
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  const period = h < 12  ? 'in the morning'
               : h < 17  ? 'in the afternoon'
               : h < 21  ? 'in the evening'
               : 'at night';
  const timeStr = m === 0 ? `${hr12} ${period}` : `${hr12} ${min} ${period}`;
  return `It's ${timeStr}.`;
}

/**
 * Show the clock panel, speak the time directly via TTS, and schedule auto-dismiss.
 * No LLM call is made — this path has near-zero latency.
 */
function handleTimeQuery(transcript) {
  const now  = new Date();
  const tz   = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Format display strings
  const timeDisplay = now.toLocaleTimeString('en-US', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const dateDisplay = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });

  // Render the clock panel
  if (clockPanel && clockTime && clockDate && clockTz) {
    clockPanel.classList.remove('hidden', 'dismissing');
    clockTime.textContent = timeDisplay;
    clockDate.textContent = dateDisplay.toUpperCase();
    clockTz.textContent   = tz;

    // Auto-dismiss after 30 seconds
    if (_clockDismissTimer) clearTimeout(_clockDismissTimer);
    _clockDismissTimer = setTimeout(() => {
      clockPanel.classList.add('dismissing');
      setTimeout(() => clockPanel.classList.add('hidden'), 800);
    }, 30_000);
  }

  // Build the spoken phrase
  const spoken = _formatTimeSpoken(now);

  // Append to chat and speak directly — no LLM round-trip
  appendMessage('user', transcript);
  const { txt } = appendMessage('assistant', spoken);
  setState('speaking');
  enqueueSpeak(spoken, () => {
    txt.textContent = spoken;
  });
}
```

---

## Step 4 — Wire into `app.js` Intercept Blocks

### In `mediaRecorder.onstop`

Add the time intercept **before** the `appendMessage('user', transcript)` / `sendToOllama` lines
(i.e. in the same intercept section as the other triggers):

```javascript
        // ── Time query intercept ──────────────────────────────────────────
        if (detectTimeTrigger(transcript)) {
          setState('idle');
          handleTimeQuery(transcript);
          return;
        }
        // ─────────────────────────────────────────────────────────────────
```

### In `handleSend`

Add the identical block inside `handleSend()`:

```javascript
  // ── Time query intercept ────────────────────────────────────────────────
  if (detectTimeTrigger(text)) {
    setState('idle');
    handleTimeQuery(text);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────
```

---

## Step 5 — Optional: LLM Path for Natural Phrasing

If you prefer Starling to phrase the time more conversationally (*"It's just gone half past two
in the afternoon"* rather than the templated output), replace `handleTimeQuery`'s direct speak
path with a `sendToOllama` call. Use an ephemeral message so the exchange doesn't pollute
conversation history:

```javascript
// Replace the "Build the spoken phrase" block onwards in handleTimeQuery with:
const freshCtx = `The current time is ${timeDisplay} on ${dateDisplay}. Timezone: ${tz}.`;
appendMessage('user', transcript);
await sendToOllama(
  'State the current time in one natural sentence. Phrase it conversationally, not robotically.',
  {
    ephemeralMessages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: `[CURRENT TIME — use this exact value]\n${freshCtx}` },
    ],
  }
);
```

Note: `handleTimeQuery` must become `async` if you use this path, and the intercept callers must
`await` it.

**Recommendation**: use the direct path (Step 3) as the default. The templated output is clear,
accurate, and immediate. Reserve the LLM path for a "natural mode" settings toggle if desired.

---

## Step 6 — Dismiss Clock Panel on Next Interaction

To close the clock panel automatically when the user starts a new interaction (so it doesn't
linger behind a follow-up weather or calendar response), add one line to `clearAudioQueue` or at
the top of `startRecording`:

```javascript
// At the top of startRecording(), after clearAudioQueue():
if (clockPanel && !clockPanel.classList.contains('hidden')) {
  clockPanel.classList.add('hidden');
  if (_clockDismissTimer) { clearTimeout(_clockDismissTimer); _clockDismissTimer = null; }
}
```

---

## File Change Summary

| File | Change |
|---|---|
| `frontend/index.html` | Add clock panel HTML (4 lines) |
| `frontend/style.css` | Append clock panel CSS block |
| `frontend/app.js` | Add `detectTimeTrigger`, `_formatTimeSpoken`, `handleTimeQuery`; add intercept block in `mediaRecorder.onstop` and `handleSend`; optional dismiss on new interaction |

No backend changes. No new dependencies. No `.env` variables.

---

## Extending to Date Queries

The same zero-latency approach works for date questions (*"what day is it"*, *"what's today's
date"*). Add a `detectDateTrigger` function with matching patterns and call a `handleDateQuery`
variant that builds a date-only spoken phrase:

```javascript
function detectDateTrigger(transcript) {
  const t = transcript.trim().toLowerCase();
  const patterns = [
    /\bwhat(?:'s| is)\s+(?:today(?:'s)?|the)\s+date\b/,
    /\bwhat\s+day\s+(?:is\s+it|of\s+the\s+week)\b/,
    /\bwhat\s+(?:day|date)\s+is\s+(?:it\s+)?today\b/,
    /\btoday(?:'s)?\s+date\b/,
  ];
  return patterns.some(p => p.test(t)) ? true : null;
}
```

Spoken output example: *"Today is Wednesday, the fourteenth of May, twenty twenty-six."*

```javascript
function _formatDateSpoken(now) {
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const ord = (n) => {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
  };
  return `Today is ${days[now.getDay()]}, the ${ord(now.getDate())} of ${months[now.getMonth()]}, ${now.getFullYear()}.`;
}
```

Wire into the same intercept block, checked **before** `detectTimeTrigger` to avoid conflicts
(date questions are more specific in phrasing and won't typically collide).
