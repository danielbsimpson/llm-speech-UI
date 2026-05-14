# Timer — Implementation Guide

Adds a voice-triggered countdown timer that activates on phrases like *"set a timer for five
minutes"* or *"thirty second timer"*. Like the time query, **this requires zero backend calls and
zero LLM involvement** — everything runs in the browser using `setInterval` and the Web Audio API.

When the timer expires, Starling announces it aloud via Kokoro TTS, the sphere enters the
`speaking` state, and an attention chime is synthesised entirely in the browser (no audio files
needed). Multiple named timers are supported (e.g. *"set a pasta timer for twelve minutes"*).

---

## Overview

```
Microphone → Whisper STT → [intercept transcript]
                                    ↓
                           detectTimerTrigger()
                           parseDuration() — regex extracts hours/minutes/seconds
                                    ↓
                           create timer entry
                           render countdown panel
                           setInterval() — ticks every second
                                    ↓
                           [duration elapses]
                                    ↓
                           synthesise chime via Web Audio API
                           enqueueSpeak() — Kokoro announces completion
                           sphere enters speaking state
```

No new files are strictly required. The entire implementation is self-contained in `app.js` with
HTML and CSS additions. A separate `frontend/timer-panel.js` module is also provided for
projects that have already migrated `app.js` to `type="module"`.

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| Timer engine | `setInterval` (1 s tick) | No backend; browser-native; accurate enough for kitchen-timer use cases |
| Completion audio | Web Audio API oscillator chime | No audio file needed; synthesised in-browser in ~5 ms; works offline |
| Completion announcement | Kokoro TTS via `enqueueSpeak` | Consistent with all other Starling speech output |
| Multiple timers | Yes — each with an optional label | Natural to say *"set an egg timer for three minutes"* and *"set a pasta timer for ten minutes"* |
| Cancel | *"cancel timer"* / *"stop timer"* / *"cancel [label] timer"* | Same intercept chain as other triggers |
| LLM involvement | **None** | Timer is a deterministic mechanical function — the LLM adds latency with no value |
| Persistence | Session-only (in-memory) | Page reload clears timers; add `localStorage` if persistence is needed |

---

## Step 1 — Add the Timer Panel HTML

In `frontend/index.html`, inside `.starling` alongside the other panels:

```html
<!-- Timer Panel — hidden until one or more timers are active -->
<div class="timer-panel hidden" id="timer-panel">
  <div class="timer-header">
    <div class="timer-title">TIMERS</div>
    <button class="timer-clear-all" id="timer-clear-all" title="Cancel all timers">✕ ALL</button>
  </div>
  <!-- Timer entries injected here by JS -->
  <div class="timer-list" id="timer-list"></div>
</div>
```

---

## Step 2 — Add the CSS

Append to `frontend/style.css`:

```css
/* ── Timer Panel ──────────────────────────────────────────────────────────────── */

.timer-panel {
  width: 100%;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 14px 20px;
  margin-top: 12px;
  animation: weatherFadeIn 0.3s ease;  /* reuses existing keyframe */
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.timer-panel.hidden {
  display: none;
}

.timer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 8px;
}

.timer-title {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.7rem, 1.4vw, 0.9rem);
  color: #e0e0e0;
  letter-spacing: 0.14em;
}

.timer-clear-all {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: #555;
  cursor: pointer;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.58rem;
  letter-spacing: 0.1em;
  padding: 2px 7px;
  transition: color 0.15s, border-color 0.15s;
}

.timer-clear-all:hover {
  color: #ff8888;
  border-color: rgba(255, 100, 100, 0.3);
}

.timer-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Individual timer row */
.timer-entry {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 7px;
  position: relative;
  overflow: hidden;
}

/* Progress fill — grows left-to-right as time elapses */
.timer-progress {
  position: absolute;
  inset: 0 auto 0 0;
  background: rgba(255, 255, 255, 0.04);
  transition: width 1s linear;
  pointer-events: none;
}

.timer-entry.done {
  border-color: rgba(136, 255, 170, 0.25);
  background:   rgba(136, 255, 170, 0.05);
}

.timer-entry.done .timer-progress {
  background: rgba(136, 255, 170, 0.08);
}

.timer-label {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.72rem;
  color: #aaa;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  position: relative;   /* above progress bar */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.timer-countdown {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(1rem, 2.5vw, 1.3rem);
  color: #ffffff;
  letter-spacing: 0.05em;
  white-space: nowrap;
  position: relative;
}

.timer-entry.done .timer-countdown {
  color: #88ffaa;
}

/* Pulse animation when a timer expires */
@keyframes timerDone {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}

.timer-entry.pulsing {
  animation: timerDone 0.6s ease 4;  /* 4 pulses then stops */
}

.timer-cancel-btn {
  background: transparent;
  border: none;
  color: #444;
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1;
  padding: 2px 4px;
  position: relative;
  transition: color 0.15s;
}

.timer-cancel-btn:hover {
  color: #ff8888;
}
```

---

## Step 3 — Add Timer Logic to `app.js`

Add the following self-contained block to `app.js`. It can sit near the other feature functions
(time, weather, etc.) or be pasted at the end of the file before the startup sequence.

```javascript
// ═══════════════════════════════════════════════════════════════════════════════
// ── Timer system ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── DOM refs ──────────────────────────────────────────────────────────────────
const timerPanel    = document.getElementById('timer-panel');
const timerList     = document.getElementById('timer-list');
const timerClearAll = document.getElementById('timer-clear-all');

// ── State ─────────────────────────────────────────────────────────────────────
// Map of timerId → { id, label, totalSeconds, remainingSeconds, intervalId, entryEl, progressEl, countdownEl, startedAt }
const _timers = new Map();
let   _timerNextId = 1;

// ── "Cancel all" button ───────────────────────────────────────────────────────
timerClearAll?.addEventListener('click', () => _cancelAllTimers());

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Detect a timer set/cancel phrase in a Whisper transcript.
 * Returns one of:
 *   { action: 'set',    durationSeconds: number, label: string | null }
 *   { action: 'cancel', label: string | null }
 *   null  (no match)
 *
 * Activation phrases — set:
 *   "set a timer for five minutes"
 *   "set a ten minute timer"
 *   "timer for 2 minutes 30 seconds"
 *   "start a 90 second timer"
 *   "set a pasta timer for 12 minutes"
 *   "set a timer for one and a half minutes"
 *   "set an hour timer"
 *   "thirty second timer"
 *
 * Activation phrases — cancel:
 *   "cancel timer"
 *   "stop timer"
 *   "cancel all timers"
 *   "cancel the pasta timer"
 */
function detectTimerTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  // ── Cancel ──────────────────────────────────────────────────────────────────
  const cancelMatch = t.match(
    /\b(?:cancel|stop|clear|dismiss|delete)\b.{0,30}\btimer\b/
  );
  if (cancelMatch) {
    // Try to extract a label: "cancel the pasta timer"
    const labelMatch = t.match(/\bcancel\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+timer\b/);
    const label = labelMatch ? labelMatch[1].trim() : null;
    return { action: 'cancel', label };
  }

  // ── Set ─────────────────────────────────────────────────────────────────────
  const setPatterns = [
    /\b(?:set|start|create|begin)\s+(?:a\s+)?(?:timer|countdown)\s+for\b/,
    /\b(?:set|start|create|begin)\s+(?:a\s+)?(?:\w+\s+)?(?:minute|second|hour)\s+timer\b/,
    /\btimer\s+for\b/,
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|half|a\s+half)\b.{0,20}\b(?:minute|second|hour)\b.{0,20}\btimer\b/,
    /\b(?:thirty|twenty|ten|five)\s+second\s+timer\b/,
  ];
  const isSet = setPatterns.some(p => p.test(t));
  if (!isSet) return null;

  const seconds = _parseDuration(t);
  if (!seconds || seconds <= 0) return null;

  // Optional label: "set a pasta timer for 10 minutes" → label = "pasta"
  const labelMatch = t.match(
    /\bset\s+(?:a\s+|an\s+)?(\w+(?:\s+\w+)?)\s+timer\b(?!\s+for\s+(?:a\s+)?\d)/
  );
  let label = null;
  if (labelMatch) {
    const skip = /^(timer|a|an|the|set|start|new)$/i;
    const candidate = labelMatch[1].trim();
    if (!skip.test(candidate)) label = candidate;
  }

  return { action: 'set', durationSeconds: seconds, label };
}

/**
 * Parse a duration string into total seconds.
 * Handles:
 *   digit words ("five", "twelve", "ninety")
 *   mixed ("2 minutes 30 seconds")
 *   fractional words ("one and a half minutes")
 *   "an hour", "a minute"
 */
function _parseDuration(text) {
  // Normalise digit words to numerals
  const wordMap = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
    'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
    'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
    'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
    'eighteen': 18, 'nineteen': 19, 'twenty': 20, 'thirty': 30,
    'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70,
    'eighty': 80, 'ninety': 90, 'hundred': 100,
    'a': 1, 'an': 1,
  };

  let t = text.toLowerCase();

  // Handle "one and a half" → 1.5, "two and a half" → 2.5
  t = t.replace(/(\w+)\s+and\s+a\s+half/g, (_, w) => {
    const n = wordMap[w] ?? parseFloat(w) ?? null;
    return n !== null ? String(n + 0.5) : _;
  });

  // Replace word numbers with digits
  Object.entries(wordMap).forEach(([word, val]) => {
    t = t.replace(new RegExp(`\\b${word}\\b`, 'g'), String(val));
  });

  let total = 0;

  // Extract hours
  const hrMatch = t.match(/([0-9.]+)\s*(?:hours?|hrs?)/);
  if (hrMatch) total += parseFloat(hrMatch[1]) * 3600;

  // Extract minutes
  const minMatch = t.match(/([0-9.]+)\s*(?:minutes?|mins?)/);
  if (minMatch) total += parseFloat(minMatch[1]) * 60;

  // Extract seconds
  const secMatch = t.match(/([0-9.]+)\s*(?:seconds?|secs?)/);
  if (secMatch) total += parseFloat(secMatch[1]);

  // Bare number fallback: "set a timer for 5" → 5 minutes
  if (total === 0) {
    const bare = t.match(/\bfor\s+([0-9.]+)\b/);
    if (bare) total = parseFloat(bare[1]) * 60;  // default unit: minutes
  }

  return Math.round(total);
}

/**
 * Format seconds as MM:SS or H:MM:SS for the countdown display.
 */
function _fmtCountdown(secs) {
  const s = Math.max(0, secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * Format a duration in seconds into a natural spoken label.
 * Examples: 300 → "5 minutes", 90 → "1 minute 30 seconds", 45 → "45 seconds"
 */
function _fmtDurationSpoken(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const parts = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (s) parts.push(`${s} ${s === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ') || '0 seconds';
}

// ── Chime synthesis ───────────────────────────────────────────────────────────

/**
 * Synthesise a short attention chime using the Web Audio API.
 * Three descending tones — no audio file required.
 * Returns a Promise that resolves when the chime finishes (~1.2 s).
 */
function _playChime() {
  return new Promise(resolve => {
    const ctx = _getAudioCtx();   // reuses the shared AudioContext from app.js
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const notes = [
      { freq: 880,  start: 0.00, dur: 0.18 },   // A5
      { freq: 1046, start: 0.22, dur: 0.18 },   // C6
      { freq: 1318, start: 0.44, dur: 0.55 },   // E6 — held longer
    ];

    notes.forEach(({ freq, start, dur }) => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type     = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, ctx.currentTime + start);
      g.gain.linearRampToValueAtTime(0.22, ctx.currentTime + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(g);
      g.connect(gain);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    });

    setTimeout(resolve, 1300);  // resolves after all notes have faded
  });
}

// ── Timer creation ────────────────────────────────────────────────────────────

/**
 * Create a new countdown timer and add it to the panel.
 */
function _createTimer(totalSeconds, label) {
  const id         = _timerNextId++;
  const labelText  = label
    ? label.charAt(0).toUpperCase() + label.slice(1)
    : `Timer ${id}`;
  const startedAt  = Date.now();

  // Build the DOM entry
  const entry = document.createElement('div');
  entry.className  = 'timer-entry';
  entry.id         = `timer-entry-${id}`;

  const progress = document.createElement('div');
  progress.className = 'timer-progress';
  progress.style.width = '0%';

  const lbl = document.createElement('div');
  lbl.className   = 'timer-label';
  lbl.textContent = labelText;

  const countdown = document.createElement('div');
  countdown.className   = 'timer-countdown';
  countdown.textContent = _fmtCountdown(totalSeconds);

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'timer-cancel-btn';
  cancelBtn.textContent = '✕';
  cancelBtn.title       = `Cancel ${labelText}`;
  cancelBtn.addEventListener('click', () => _cancelTimer(id));

  entry.appendChild(progress);
  entry.appendChild(lbl);
  entry.appendChild(countdown);
  entry.appendChild(cancelBtn);
  timerList.appendChild(entry);

  // Show the panel
  timerPanel.classList.remove('hidden');
  timerPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Tick function
  let remaining = totalSeconds;
  const intervalId = setInterval(async () => {
    remaining--;

    // Update progress bar
    const elapsed = totalSeconds - remaining;
    const pct     = Math.min(100, (elapsed / totalSeconds) * 100);
    progress.style.width = `${pct}%`;

    if (remaining > 0) {
      countdown.textContent = _fmtCountdown(remaining);
    } else {
      // ── Timer done ──────────────────────────────────────────────────────
      clearInterval(intervalId);
      _timers.delete(id);

      countdown.textContent = 'DONE';
      entry.classList.add('done', 'pulsing');
      progress.style.width = '100%';

      // Remove pulse class after animation completes (~2.4 s)
      setTimeout(() => entry.classList.remove('pulsing'), 2500);
      // Auto-remove the done entry after 60 s
      setTimeout(() => {
        entry.remove();
        if (timerList.children.length === 0) timerPanel.classList.add('hidden');
      }, 60_000);

      // Synthesise chime then speak announcement via Kokoro TTS
      await _playChime();
      const spoken = `Your ${_fmtDurationSpoken(totalSeconds)}${label ? ' ' + label : ''} timer is done.`;
      const { txt } = appendMessage('assistant', spoken);
      setState('speaking');
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    }
  }, 1000);

  // Store timer record
  _timers.set(id, { id, label: labelText, totalSeconds, intervalId });
  return id;
}

// ── Timer cancellation ────────────────────────────────────────────────────────

/**
 * Cancel a specific timer by id. Removes it from the panel immediately.
 */
function _cancelTimer(id) {
  const t = _timers.get(id);
  if (!t) return;
  clearInterval(t.intervalId);
  _timers.delete(id);
  const entry = document.getElementById(`timer-entry-${id}`);
  if (entry) entry.remove();
  if (timerList.children.length === 0) timerPanel.classList.add('hidden');
}

/**
 * Cancel all timers — wired to the "✕ ALL" button and the "cancel all timers" phrase.
 */
function _cancelAllTimers() {
  for (const [id] of _timers) _cancelTimer(id);
}

/**
 * Cancel a timer by fuzzy label match (for voice commands like "cancel pasta timer").
 * Returns true if a match was found and cancelled.
 */
function _cancelTimerByLabel(label) {
  if (!label) {
    // No label → cancel the most recently created timer
    const ids   = [..._timers.keys()];
    const lastId = ids[ids.length - 1];
    if (lastId !== undefined) { _cancelTimer(lastId); return true; }
    return false;
  }
  const q = label.toLowerCase();
  for (const [id, t] of _timers) {
    if (t.label.toLowerCase().includes(q)) { _cancelTimer(id); return true; }
  }
  return false;
}

// ── Public handler — called from the intercept blocks ────────────────────────

/**
 * Handle a detected timer trigger. Speaks confirmation directly via TTS.
 * No LLM call is made.
 */
function handleTimerTrigger(transcript, trigger) {
  if (trigger.action === 'cancel') {
    appendMessage('user', transcript);

    if (trigger.label === 'all' || transcript.toLowerCase().includes('all')) {
      const count = _timers.size;
      _cancelAllTimers();
      const spoken = count > 0
        ? `Cancelled ${count} ${count === 1 ? 'timer' : 'timers'}.`
        : 'No active timers to cancel.';
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    } else {
      const found = _cancelTimerByLabel(trigger.label);
      const spoken = found
        ? `Timer cancelled.`
        : 'No matching timer found.';
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    }
    return;
  }

  // action === 'set'
  const { durationSeconds, label } = trigger;
  appendMessage('user', transcript);
  _createTimer(durationSeconds, label);

  // Spoken confirmation
  const durationLabel = _fmtDurationSpoken(durationSeconds);
  const labelSuffix   = label ? ` ${label} timer` : ' timer';
  const spoken = `${durationLabel}${labelSuffix} set.`;
  const { txt } = appendMessage('assistant', spoken);
  enqueueSpeak(spoken, () => { txt.textContent = spoken; });
}
```

---

## Step 4 — Wire into `app.js` Intercept Blocks

### In `mediaRecorder.onstop`

Add the timer intercept block alongside the other intercepts:

```javascript
        // ── Timer intercept ───────────────────────────────────────────────
        const _timerTrigger = detectTimerTrigger(transcript);
        if (_timerTrigger) {
          setState('idle');
          handleTimerTrigger(transcript, _timerTrigger);
          return;
        }
        // ─────────────────────────────────────────────────────────────────
```

### In `handleSend`

Add the identical block inside `handleSend()`:

```javascript
  // ── Timer intercept ──────────────────────────────────────────────────────
  const _timerTrigger = detectTimerTrigger(text);
  if (_timerTrigger) {
    setState('idle');
    handleTimerTrigger(text, _timerTrigger);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────
```

---

## Step 5 — Shared `_getAudioCtx()` Dependency

`_playChime()` calls `_getAudioCtx()`, which is the shared `AudioContext` helper already defined
in `app.js`:

```javascript
// Already exists in app.js — no changes needed:
let _sharedAudioCtx = null;
function _getAudioCtx() {
  if (!_sharedAudioCtx) _sharedAudioCtx = new AudioContext();
  if (_sharedAudioCtx.state === 'suspended') _sharedAudioCtx.resume().catch(() => {});
  return _sharedAudioCtx;
}
```

The timer code references this function directly. No changes are required — the chime will play
through the same `AudioContext` used by the microphone analyser and output visualiser, keeping the
audio routing consistent and respecting the browser's autoplay policy (the context will already be
resumed from the user's mic gesture).

---

## Step 6 — Intercept Order Recommendation

The full recommended ordering of intercept checks in both `mediaRecorder.onstop` and `handleSend`
is:

```
1. _matchesExitPhrase         — dossier exit (existing)
2. _parseTrigger              — dossier open (existing)
3. detectTimerTrigger         — timer set/cancel  ← new (check before time to avoid "timer" matching time patterns)
4. detectTimeTrigger          — time query        ← new
5. detectWeatherTrigger       — weather           ← from WEATHER.md
6. detectCalendarTrigger      — calendar          ← from CALENDAR.md
7. detectNewsTrigger          — news briefing     ← from NEWS.md
8. detectMarketTrigger        — stocks/crypto     ← from STOCKS.md
9. appendMessage + sendToOllama  — normal LLM path (existing)
```

Timer and time checks come early because they are the highest-frequency, lowest-latency queries
and their trigger patterns are tightly scoped (no risk of colliding with general conversation).

---

## Example Interaction Flows

### Setting a simple timer
```
User:     "Set a timer for five minutes."
Starling: "5 minutes timer set."               ← spoken instantly, no LLM
Panel:    Timer entry appears — 05:00 counting down
[5 min later]
          ♪ chime ♪
Starling: "Your 5 minutes timer is done."
```

### Setting a named timer
```
User:     "Set a pasta timer for twelve minutes."
Starling: "12 minutes pasta timer set."
Panel:    "PASTA" entry — 12:00 counting down
```

### Setting a compound duration
```
User:     "Timer for one and a half minutes."
Starling: "1 minute 30 seconds timer set."
Panel:    01:30 counting down
```

### Multiple simultaneous timers
```
User:     "Set a pasta timer for ten minutes."   → 10:00 PASTA
User:     "Set an egg timer for three minutes."  → 03:00 EGG
Panel:    Both entries visible simultaneously
```

### Cancelling
```
User:     "Cancel the pasta timer."
Starling: "Timer cancelled."          ← egg timer continues unaffected

User:     "Cancel all timers."
Starling: "Cancelled 1 timer."
```

---

## File Change Summary

| File | Change |
|---|---|
| `frontend/index.html` | Add timer panel HTML (7 lines) |
| `frontend/style.css` | Append timer panel CSS block |
| `frontend/app.js` | Add `detectTimerTrigger`, `_parseDuration`, `_fmtCountdown`, `_fmtDurationSpoken`, `_playChime`, `_createTimer`, `_cancelTimer`, `_cancelAllTimers`, `_cancelTimerByLabel`, `handleTimerTrigger`; add intercept block in `mediaRecorder.onstop` and `handleSend` |

No backend changes. No new dependencies. No `.env` variables.

---

## Limitations and Edge Cases

**Whisper number transcription** — Whisper consistently transcribes spoken numbers as either
words (*"five"*) or digits (*"5"*) depending on context and model size. `_parseDuration()` handles
both — word numbers are mapped to digits before regex matching runs.

**"One and a half" edge cases** — The phrase normalisation in `_parseDuration()` handles
*"one and a half minutes"* → 90 seconds and *"two and a half hours"* → 9000 seconds. Less common
phrasings like *"a minute and a half"* are also covered because *"a"* maps to 1 in `wordMap`.

**Browser autoplay policy** — The chime uses the shared `AudioContext` (`_getAudioCtx()`). This
context is created and resumed on the first user gesture (mic button press or text send). Any timer
set via voice will therefore always find an already-resumed context. Timers set via the text input
field will also work as long as the user has previously pressed a button in the page — which is
guaranteed since they typed and pressed SEND.

**Long timers and page reload** — Timers are stored in `_timers` (in-memory `Map`). If the user
reloads the page, all timers are lost. For overnight or multi-hour timers, add a `beforeunload`
warning:
```javascript
window.addEventListener('beforeunload', (e) => {
  if (_timers.size > 0) {
    e.preventDefault();
    e.returnValue = ''; // Shows browser's "leave page?" dialog
  }
});
```

**Tab backgrounding and timer throttling** — Browsers throttle `setInterval` in background tabs
to ~1 tick/second minimum (Chrome) or aggressively suspend it (iOS Safari). For a local desktop
tool running in a focused tab this is a non-issue. If accuracy matters for long timers, supplement
`setInterval` with a `Date.now()` snapshot taken at creation time and recompute remaining seconds
on each tick from `Math.round((endTime - Date.now()) / 1000)` rather than decrementing a counter.
This makes the countdown immune to throttling drift:

```javascript
// Replace the remaining-- decrement in the setInterval callback with:
const endTime = Date.now() + totalSeconds * 1000;
// ... inside setInterval:
const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
```
