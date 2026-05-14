# Wake Word & Interruptible Conversations — Implementation Guide

Two closely related features covered in a single guide because they share the same always-on
audio listener:

- **Wake word** — "Hey Starling" automatically triggers the mic without pressing a button
- **Interrupt** — speaking "hey Starling" (or pressing Escape / spacebar) while Starling is
  talking immediately stops the current speech and starts listening for the next input

Both features are **frontend-only** — no backend changes are required.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  ALWAYS-ON LISTENER (Web Speech API, continuous, interim results)   │
│  Running silently in the background at all times                     │
└─────────────────────────────────────────────────────────────────────┘
            │                              │
            ▼                              ▼
  Wake word detected               Interrupt phrase detected
  (state = idle / transcribing)    (state = speaking / thinking)
            │                              │
            ▼                              ▼
   startRecording()              clearAudioQueue()
   (existing push-to-talk         + startRecording()
    flow resumes as normal)       (cut off current speech
                                   immediately, start listening)
```

The Web Speech API listener never captures "real" transcripts — it only watches for the wake
word and interrupt phrases in `interimResults`. All actual STT continues to go through Whisper
via the existing `MediaRecorder` → `POST /transcribe/` pipeline. This gives you Google-quality
wake word detection (Chrome/Edge) with Whisper accuracy for the actual conversation.

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| Wake word engine | Web Speech API (continuous, interim) | Zero dependencies; no new backend; free; works in Chrome and Edge — the two most common browsers for this kind of local AI UI |
| Privacy tradeoff | Documented — audio goes to Google for wake word detection only | Actual conversation audio still processed locally by Whisper. See Porcupine WASM appendix for a fully offline alternative |
| Wake phrase | "Hey Starling" (+ common mishearing variants) | Matches the project name; "hey" prefix reduces false positives |
| Interrupt trigger | Same wake word, detected mid-speech | Single phrase for both activate and interrupt keeps the UX simple |
| Hard interrupt keys | Spacebar, Escape | Spacebar already starts recording; Escape added as a dedicated stop-speaking key |
| Auto-stop timeout | 8 seconds of silence after wake word → auto-stop | Prevents the recorder running indefinitely if the user forgets to finish speaking |
| Visual indicator | Pulsing wake word badge in the UI | User knows the always-on listener is active |
| State guard | Wake word ignored while `listening` or `transcribing` | Prevents double-recording |

---

## Part 1 — Wake Word Listener Module

### Step 1 — Create `frontend/wake-word.js`

```javascript
// frontend/wake-word.js
// Always-on Web Speech API listener for wake word + interrupt detection.
// Does NOT perform real transcription — delegates to the existing
// MediaRecorder → Whisper pipeline once the wake word is heard.

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * All phrases that count as the wake word.
 * Include common mishearings (Starling → Sterling, Sterling → Starling).
 * All comparisons are lower-case.
 */
const WAKE_PHRASES = [
  'hey starling',
  'hey sterling',   // common mishearing
  'hey starlng',    // STT typo
  'okay starling',
  'ok starling',
  'hi starling',
];

/**
 * Phrases that interrupt Starling mid-speech without activating the mic.
 * These are checked only while state === 'speaking'.
 */
const STOP_PHRASES = [
  'stop',
  'stop it',
  'be quiet',
  'shut up',
  'cancel',
  'silence',
  'enough',
  'pause',
  'hold on',
  'wait',
];

// Silence timeout after wake word activates mic (ms).
// If the user doesn't speak, recording stops automatically.
const AUTO_STOP_MS = 8000;

// ── State ─────────────────────────────────────────────────────────────────────
let _recognition     = null;    // SpeechRecognition instance
let _enabled         = false;   // whether the wake word listener is currently running
let _autoStopTimer   = null;    // setTimeout handle for auto-stop

// ── Callbacks — wired by app.js ───────────────────────────────────────────────
let _onWakeWord    = null;   // () => void   — called when wake word detected in idle/transcribing
let _onInterrupt   = null;   // () => void   — called when stop phrase detected while speaking
let _onListenerOn  = null;   // () => void   — called when listener successfully starts
let _onListenerOff = null;   // () => void   — called when listener stops

// ── Public API ────────────────────────────────────────────────────────────────

export function isWakeWordSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Wire the callbacks and start the always-on listener.
 * Call once during app initialisation.
 */
export function initWakeWord({ onWakeWord, onInterrupt, onListenerOn, onListenerOff, getState }) {
  if (!isWakeWordSupported()) {
    console.warn('[wake-word] Web Speech API not supported in this browser. ' +
                 'Wake word unavailable. Use Chrome or Edge.');
    return false;
  }

  _onWakeWord    = onWakeWord;
  _onInterrupt   = onInterrupt;
  _onListenerOn  = onListenerOn;
  _onListenerOff = onListenerOff;

  _buildRecognition(getState);
  return true;
}

/** Start the always-on wake word listener. */
export function startWakeWordListener() {
  if (!_recognition || _enabled) return;
  try {
    _recognition.start();
  } catch { /* already started — ignore */ }
}

/** Stop the always-on listener (e.g. when the user disables the feature). */
export function stopWakeWordListener() {
  _enabled = false;
  try { _recognition?.stop(); } catch { /* ignore */ }
  if (_onListenerOff) _onListenerOff();
}

/** Returns true if the always-on listener is currently running. */
export function isListening() { return _enabled; }

// ── Internal ──────────────────────────────────────────────────────────────────

function _buildRecognition(getState) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  _recognition = new SpeechRecognition();

  _recognition.continuous      = true;
  _recognition.interimResults  = true;    // gives us results as the user speaks
  _recognition.lang            = 'en-US';
  _recognition.maxAlternatives = 1;

  _recognition.onstart = () => {
    _enabled = true;
    if (_onListenerOn) _onListenerOn();
  };

  _recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result     = event.results[i];
      const transcript = result[0].transcript.trim().toLowerCase();
      const state      = getState();   // current app state machine value

      // ── Interrupt path — check first so stop phrases work even if they
      //    accidentally also match a wake phrase ─────────────────────────
      if (state === 'speaking' || state === 'thinking') {
        if (_matchesAny(transcript, STOP_PHRASES) || _matchesAny(transcript, WAKE_PHRASES)) {
          _cancelAutoStop();
          if (_onInterrupt) _onInterrupt();
          return;
        }
      }

      // ── Wake word path ────────────────────────────────────────────────
      // Only activate when idle (or transcribing / error state — safe to restart)
      if (state === 'idle' || state === 'error') {
        if (_matchesAny(transcript, WAKE_PHRASES)) {
          _cancelAutoStop();
          if (_onWakeWord) _onWakeWord();
          // Auto-stop safety: if recording is never explicitly stopped, stop it after timeout
          _autoStopTimer = setTimeout(() => {
            // Dispatch a synthetic mouseup on the mic button to trigger stopRecording()
            const micBtn = document.getElementById('mic-btn');
            if (micBtn) micBtn.dispatchEvent(new Event('mouseup'));
          }, AUTO_STOP_MS);
        }
      }
    }
  };

  _recognition.onerror = (event) => {
    // 'no-speech' and 'aborted' are normal — restart silently
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      console.warn('[wake-word] Microphone permission denied for wake word listener.');
      _enabled = false;
      if (_onListenerOff) _onListenerOff();
      return;
    }
    // All other errors: restart after a short delay
    _enabled = false;
    setTimeout(() => {
      if (_recognition) {
        try { _recognition.start(); } catch { /* ignore */ }
      }
    }, 1500);
  };

  _recognition.onend = () => {
    _enabled = false;
    if (_onListenerOff) _onListenerOff();
    // Auto-restart unless explicitly stopped
    setTimeout(() => {
      if (_recognition) {
        try { _recognition.start(); } catch { /* ignore */ }
      }
    }, 500);
  };
}

function _matchesAny(transcript, phrases) {
  return phrases.some(p => transcript.includes(p));
}

function _cancelAutoStop() {
  if (_autoStopTimer !== null) {
    clearTimeout(_autoStopTimer);
    _autoStopTimer = null;
  }
}
```

---

## Part 2 — UI Additions

### Step 2 — Add Wake Word Toggle HTML

In `frontend/index.html`, add a wake word indicator/toggle near the existing controls. A good
position is inside `.bottom-bar` alongside the existing mic button and TTS toggle:

```html
<!-- Wake word toggle — add inside .bottom-bar, after tts-toggle -->
<button class="wake-toggle" id="wake-toggle" title="Toggle always-on wake word listener">
  <span class="wake-toggle-icon">◉</span>
  <span class="wake-toggle-label" id="wake-toggle-label">WAKE</span>
</button>

<!-- Wake word status indicator — shown top-right or in footer -->
<div class="wake-indicator hidden" id="wake-indicator">
  <div class="wake-dot" id="wake-dot"></div>
  <span class="wake-label" id="wake-label">HEY STARLING</span>
</div>
```

Place the indicator somewhere always visible — either in the footer status bar or as a small
floating badge. Example position: inside `.footer-bar` after the existing status chips:

```html
<!-- Inside .footer-bar -->
<div class="wake-indicator hidden" id="wake-indicator">
  <div class="wake-dot"></div>
  <span class="wake-label">HEY STARLING</span>
</div>
```

### Step 3 — Add CSS

Append to `frontend/style.css`:

```css
/* ── Wake Word Indicator & Toggle ─────────────────────────────────────────────── */

/* Floating indicator badge — shown in footer when listener is active */
.wake-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.wake-indicator.hidden { display: none; }

/* Active state — listener running */
.wake-indicator.active {
  border-color: rgba(120, 220, 140, 0.25);
  background:   rgba(120, 220, 140, 0.04);
}

/* Triggered state — wake word just heard, mic now recording */
.wake-indicator.triggered {
  border-color: rgba(100, 180, 255, 0.35);
  background:   rgba(100, 180, 255, 0.06);
}

.wake-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #444;
  transition: background 0.2s;
}

.wake-indicator.active   .wake-dot { background: rgba(120, 220, 140, 0.8); animation: wakePulse 2.5s ease infinite; }
.wake-indicator.triggered .wake-dot { background: rgba(100, 180, 255, 0.9); animation: wakePulse 0.6s ease infinite; }

@keyframes wakePulse {
  0%, 100% { opacity: 1;   transform: scale(1);    }
  50%       { opacity: 0.4; transform: scale(0.65); }
}

.wake-label {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.55rem;
  color: #444;
  letter-spacing: 0.1em;
}

.wake-indicator.active    .wake-label { color: rgba(120, 220, 140, 0.7); }
.wake-indicator.triggered .wake-label { color: rgba(100, 180, 255, 0.8); }

/* Wake toggle button in bottom bar */
.wake-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  color: #444;
  cursor: pointer;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.6rem;
  letter-spacing: 0.08em;
  padding: 4px 8px;
  transition: color 0.15s, border-color 0.15s;
  user-select: none;
}

.wake-toggle:hover { color: #888; border-color: rgba(255,255,255,0.15); }

.wake-toggle.active {
  color: rgba(120, 220, 140, 0.8);
  border-color: rgba(120, 220, 140, 0.3);
}

.wake-toggle-icon { font-size: 0.75rem; }

/* Interrupt flash — brief visual on the sphere container when speech is cut */
@keyframes interruptFlash {
  0%   { box-shadow: 0 0 0 0 rgba(255, 120, 80, 0.0); }
  30%  { box-shadow: 0 0 18px 4px rgba(255, 120, 80, 0.35); }
  100% { box-shadow: 0 0 0 0 rgba(255, 120, 80, 0.0); }
}

.sphere-container.interrupt-flash {
  animation: interruptFlash 0.45s ease forwards;
}
```

---

## Part 3 — Wire into `app.js`

### Step 4 — Import

```javascript
import {
  isWakeWordSupported,
  initWakeWord,
  startWakeWordListener,
  stopWakeWordListener,
  isListening as isWakeListening,
} from './wake-word.js';
```

### Step 5 — Add Wake Word Initialisation

Add this block in the initialisation section of `app.js`, **after** `warmupModels()` resolves
(the wake word listener must start only after user gesture):

```javascript
// ── Wake word init ────────────────────────────────────────────────────────────
const wakeToggleBtn  = document.getElementById('wake-toggle');
const wakeIndicator  = document.getElementById('wake-indicator');
let   _wakeEnabled   = localStorage.getItem('starling_wake') !== 'false'; // persisted

function _setWakeUI(active, triggered = false) {
  if (!wakeIndicator) return;
  wakeIndicator.classList.toggle('hidden',    !active);
  wakeIndicator.classList.toggle('active',     active && !triggered);
  wakeIndicator.classList.toggle('triggered',  active && triggered);
  wakeToggleBtn?.classList.toggle('active', active);
}

function _triggerInterruptFlash() {
  const sc = document.querySelector('.sphere-container') ?? document.getElementById('sphere-canvas')?.parentElement;
  if (!sc) return;
  sc.classList.remove('interrupt-flash');
  void sc.offsetWidth;   // force reflow to restart animation
  sc.classList.add('interrupt-flash');
  setTimeout(() => sc.classList.remove('interrupt-flash'), 500);
}

const wakeSupported = isWakeWordSupported();

if (wakeSupported) {
  initWakeWord({
    getState: () => sphereStateRef.current,

    onWakeWord: () => {
      const state = sphereStateRef.current;
      // Guard — do not interrupt an in-progress recording or transcription
      if (state === 'listening' || state === 'transcribing') return;
      _setWakeUI(true, true);
      startRecording();
      // Return indicator to non-triggered state once recording ends
      setTimeout(() => _setWakeUI(_wakeEnabled), 500);
    },

    onInterrupt: () => {
      _triggerInterruptFlash();
      clearAudioQueue();
      setState('idle');
      // Short pause then start listening for what the user wants next
      setTimeout(() => {
        startRecording();
        _setWakeUI(true, true);
        setTimeout(() => _setWakeUI(_wakeEnabled), 500);
      }, 250);
    },

    onListenerOn:  () => _setWakeUI(_wakeEnabled),
    onListenerOff: () => { if (_wakeEnabled) _setWakeUI(false); },
  });

  // Start the listener after first user gesture — mic button is the natural trigger
  // If the user has wake word enabled, start it now (warmupModels has already run
  // so there is technically a gesture already, but the indicator will appear only
  // once the user interacts with the page at least once).
  if (_wakeEnabled) {
    // Defer slightly so browser doesn't block autostart before any gesture
    window.addEventListener('click', function _startOnGesture() {
      window.removeEventListener('click', _startOnGesture);
      if (_wakeEnabled) startWakeWordListener();
    }, { once: true });
  }

  // Toggle button
  wakeToggleBtn?.addEventListener('click', () => {
    _wakeEnabled = !_wakeEnabled;
    localStorage.setItem('starling_wake', String(_wakeEnabled));
    if (_wakeEnabled) {
      startWakeWordListener();
    } else {
      stopWakeWordListener();
      _setWakeUI(false);
    }
  });

  // Show toggle button (it's hidden by default for non-supporting browsers)
  wakeToggleBtn?.classList.remove('hidden');
} else {
  // Browser doesn't support Web Speech API — hide the toggle, don't show errors
  wakeToggleBtn?.classList.add('hidden');
  console.info('[wake-word] Web Speech API not available. Wake word disabled.');
}
// ─────────────────────────────────────────────────────────────────────────────
```

### Step 6 — Add Escape Key Interrupt

The Escape key provides a hard stop for all speech/audio without activating the mic.
Add to the existing `keydown` listener block:

```javascript
// ── Escape key — hard stop of any in-progress speech ─────────────────────────
document.addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    const state = sphereStateRef.current;
    if (state === 'speaking' || state === 'thinking' || state === 'transcribing') {
      _triggerInterruptFlash();
      clearAudioQueue();
      // Also stop any in-progress recording
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        micBtn.classList.remove('recording');
      }
      setState('idle');
    }
  }
  // ... existing Space key handler below ...
});
```

### Step 7 — Add Spacebar Interrupt Behaviour

The spacebar already starts recording, but it currently does NOT stop Starling if she is
speaking (only `clearAudioQueue()` is called in `startRecording`). Make the behaviour explicit
and add a visual flash:

```javascript
// ── Push-to-talk — spacebar ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.activeElement !== textInput && !e.repeat) {
    e.preventDefault();
    const state = sphereStateRef.current;
    if (state === 'speaking') {
      // If Starling is speaking: flash + interrupt, then start listening
      _triggerInterruptFlash();
    }
    startRecording();   // clearAudioQueue() is called inside startRecording
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && document.activeElement !== textInput) {
    e.preventDefault();
    stopRecording();
  }
});
```

> **Note:** `startRecording()` already calls `clearAudioQueue()` at its first line —
> spacebar pressing mid-speech already works. This change just adds the visual interrupt flash.

### Step 8 — Persist Wake Word Preference

The `localStorage.getItem('starling_wake')` / `localStorage.setItem` calls in Step 5 already
handle persistence. No additional code is needed.

---

## Part 4 — Mic Button as Interrupt

The mic button already interrupts speech because `startRecording()` calls `clearAudioQueue()`
immediately. Add the visual flash so the feedback is consistent:

In the existing `micBtn` mousedown listener, replace or extend:

```javascript
micBtn.addEventListener('mousedown', () => {
  if (sphereStateRef.current === 'speaking') {
    _triggerInterruptFlash();
  }
  startRecording();
});
```

The `_triggerInterruptFlash` function must be defined before this listener (it is in Step 5
above).

---

## Interaction Flows

### Wake word activation (hands-free)
```
Starling:  [idle, listening silently via Web Speech API]
User:      "Hey Starling, what's the weather today?"
               ↑ wake word detected in interim results
Indicator: dot turns blue / triggered
Starling:  [startRecording() called — MediaRecorder starts]
           [user finishes speaking — stopRecording() fires automatically via auto-stop OR
            user presses mic to stop early]
           [Whisper transcribes "what's the weather today?"]
           [weather trigger fires → speaks forecast]
```

### Interrupt mid-speech
```
Starling:  "The weather today in New York will be partly cloudy with a high of—"
User:      "Hey Starling" (or "stop" / presses Escape)
               ↑ detected by always-on listener  OR  Escape/spacebar keydown
Starling:  [clearAudioQueue() → speech stops immediately]
           [brief flash on sphere container]
           [after 250ms delay → startRecording() → listening]
User:      "Just give me the temperature."
Starling:  "The high today is 72 degrees."
```

### Interrupt via mic button
```
Starling:  [speaking — state = 'speaking']
User:      [holds spacebar OR clicks mic button]
Starling:  [clearAudioQueue() fires inside startRecording()]
           [flash animation plays]
           [state transitions: speaking → listening]
User:      [speaks]
```

### Wake word disabled
```
User:      [clicks WAKE toggle button]
Indicator: badge disappears
Starling:  [stopWakeWordListener() — SpeechRecognition.stop()]
           [preference saved to localStorage]
User:      [clicks WAKE again → re-enabled, listener restarts]
```

---

## Privacy Notice

The Web Speech API sends audio to Google's speech recognition servers **for wake word detection
only**. The actual conversation (everything after the wake word activates the mic) is processed
entirely locally by Whisper via your FastAPI backend — it never leaves your machine.

The wake word indicator in the UI makes it explicit when the always-on listener is active.
Users can disable it at any time via the WAKE toggle; the preference is persisted.

### Fully Offline Alternative — Porcupine WASM

[Picovoice Porcupine](https://picovoice.ai/platform/porcupine/) runs entirely in the browser
via WebAssembly — no audio ever leaves the machine.

```
npm install @picovoice/porcupine-web @picovoice/web-voice-processor
```

Create a custom wake word model for "Hey Starling" on the Picovoice Console (free tier allows
3 custom wake words). The integration replaces the `SpeechRecognition` block in `wake-word.js`
with the Porcupine Web SDK — everything else (callbacks, UI, state guards) remains identical.

Porcupine tradeoffs:
- ✅ Fully offline — zero audio leaves the device
- ✅ Very low false positive rate with a custom model
- ✅ Works in Firefox, Safari, Chrome, Edge
- ⚠ Requires a free Picovoice account and API key (key embedded in the frontend — acceptable
    for local personal use)
- ⚠ Custom wake word model takes ~24 h to train on Picovoice Console

---

## File Change Summary

| File | Change |
|---|---|
| `frontend/wake-word.js` | **New file** — always-on Web Speech API listener, wake word + interrupt detection, auto-stop timer |
| `frontend/index.html` | Add wake indicator badge (footer) + WAKE toggle button (bottom bar) |
| `frontend/style.css` | Append wake indicator, wake toggle, and interrupt flash animation CSS |
| `frontend/app.js` | Import module; `initWakeWord()` call on init; `_setWakeUI()` helper; `_triggerInterruptFlash()` helper; Escape key listener; mic button flash on interrupt; spacebar flash on interrupt |

No backend changes required.

---

## Limitations and Edge Cases

**Chrome / Edge only** — The Web Speech API (`webkitSpeechRecognition`) is not available in
Firefox or Safari. The code detects support via `isWakeWordSupported()` and hides the toggle
button silently in unsupported browsers. Push-to-talk continues to work normally.

**Microphone conflict** — The Web Speech API and `MediaRecorder` both request microphone access.
Most browsers multiplex the microphone without conflict, but some may produce audio dropouts
during the handoff. The state guard in `onWakeWord` (`state === 'listening'` → return early)
prevents double-recording if both happen to fire at once.

**Wake word during thinking** — The wake word is intentionally NOT acted on while
`state === 'thinking'` (LLM generating). Interrupting during generation would discard the
response. If you want to allow this, add `'thinking'` to the `onWakeWord` state check. Note
that the `clearAudioQueue()` + `startRecording()` in `onInterrupt` DOES fire during `thinking`
so the interrupt path works at all stages.

**`_triggerInterruptFlash` requires `.sphere-container`** — Adjust the selector to match
whatever class or id wraps the Three.js canvas in your `index.html`. Common names:
`.sphere-wrapper`, `#sphere-container`, `.orb-container`.

**Auto-stop timer** — After the wake word fires `startRecording()`, an `AUTO_STOP_MS` (8 s)
timer dispatches a synthetic `mouseup` on the mic button. This covers the case where the user
says "Hey Starling" and then stops talking without pressing the mic again. Adjust
`AUTO_STOP_MS` to taste — 5 s is snappier, 12 s gives more breathing room.

**False positives** — "Hey Starling" is a low-collision phrase, but any phrase containing
"starling" (e.g. "a starling flew past") will trigger it. Add a confidence threshold check
if `result.isFinal` is true and `result[0].confidence > 0.7` to reduce misfires:

```javascript
_recognition.onresult = (event) => {
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result     = event.results[i];
    const transcript = result[0].transcript.trim().toLowerCase();
    // Only act on final results with sufficient confidence
    // (interimResults still needed for speed, but filter low-confidence hits)
    if (result.isFinal && result[0].confidence < 0.65) continue;
    // ... rest of detection logic
  }
};
```
