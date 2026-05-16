// ═══════════════════════════════════════════════════════════════════════════════
// ── timer-panel.js ────────────────────────────────────────────────────────────
// Self-contained timer module. Import into app.js and call initTimerPanel()
// once to inject the three required callbacks.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Injected callbacks (set via initTimerPanel) ───────────────────────────────
let _appendMessage = () => ({ txt: { textContent: '' } });
let _setState      = () => {};
let _enqueueSpeak  = () => {};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const timerPanel    = document.getElementById('timer-panel');
const timerList     = document.getElementById('timer-list');
const timerClearAll = document.getElementById('timer-clear-all');

// ── Local AudioContext ────────────────────────────────────────────────────────
let _sharedAudioCtx = null;
function _getAudioCtx() {
  if (!_sharedAudioCtx) _sharedAudioCtx = new AudioContext();
  if (_sharedAudioCtx.state === 'suspended') _sharedAudioCtx.resume().catch(() => {});
  return _sharedAudioCtx;
}

// ── State ─────────────────────────────────────────────────────────────────────
// Map of timerId → { id, label, totalSeconds, intervalId }
const _timers    = new Map();
let   _timerNextId       = 1;
let   _panelDismissTimer = null;

// Hide the panel and clear all done entries.
function _dismissPanel() {
  _panelDismissTimer = null;
  timerPanel.classList.add('hidden');
  timerList.innerHTML = '';
}

// Schedule panel hide after 8 s if there are no more active timers.
function _scheduleAutoDismiss() {
  if (_timers.size > 0) return;          // still active timers — don't dismiss
  if (_panelDismissTimer) return;        // already scheduled
  _panelDismissTimer = setTimeout(_dismissPanel, 8000);
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Wire up the three callbacks that live in app.js.
 * Must be called once before any timer can be created.
 */
export function initTimerPanel({ appendMessage, setState, enqueueSpeak }) {
  _appendMessage = appendMessage;
  _setState      = setState;
  _enqueueSpeak  = enqueueSpeak;

  timerClearAll?.addEventListener('click', () => _cancelAllTimers());
}

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
export function detectTimerTrigger(transcript) {
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

  // Optional label extraction — two strategies:

  // 1. Highest priority: "called/named" suffix — "set a timer for 5 minutes called pasta"
  let label = null;
  const calledMatch = t.match(/\b(?:called|named)\s+([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*)*)\b/);
  if (calledMatch) {
    label = calledMatch[1].trim();
  }

  // 2. Fallback: "set a pasta timer for 10 minutes" → label = "pasta"
  // Skip candidates that start with a digit or consist entirely of duration words.
  if (!label) {
    const labelMatch = t.match(
      /\bset\s+(?:a\s+|an\s+)?(\w+(?:\s+\w+)?)\s+timer\b(?!\s+for\s+(?:a\s+)?\d)/
    );
    if (labelMatch) {
      const skip = /^(timer|a|an|the|set|start|new)$/i;
      const durationWordRe = /^(?:\d+|minute|minutes|second|seconds|hour|hours|min|mins|sec|secs)$/;
      const candidate = labelMatch[1].trim();
      const isDurationPhrase = candidate.split(/\s+/).every(w => durationWordRe.test(w));
      if (!skip.test(candidate) && !isDurationPhrase && !/^\d/.test(candidate)) {
        label = candidate;
      }
    }
  }

  return { action: 'set', durationSeconds: seconds, label };
}

// ── Duration parser ───────────────────────────────────────────────────────────

/**
 * Parse a duration string into total seconds.
 * Handles:
 *   digit words ("five", "twelve", "ninety")
 *   mixed ("2 minutes 30 seconds")
 *   fractional words ("one and a half minutes")
 *   "an hour", "a minute"
 */
function _parseDuration(text) {
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

  const hrMatch  = t.match(/([0-9.]+)\s*(?:hours?|hrs?)/);
  if (hrMatch)  total += parseFloat(hrMatch[1]) * 3600;

  const minMatch = t.match(/([0-9.]+)\s*(?:minutes?|mins?)/);
  if (minMatch) total += parseFloat(minMatch[1]) * 60;

  const secMatch = t.match(/([0-9.]+)\s*(?:seconds?|secs?)/);
  if (secMatch) total += parseFloat(secMatch[1]);

  // Bare number fallback: "set a timer for 5" → 5 minutes
  if (total === 0) {
    const bare = t.match(/\bfor\s+([0-9.]+)\b/);
    if (bare) total = parseFloat(bare[1]) * 60;
  }

  return Math.round(total);
}

// ── Formatters ────────────────────────────────────────────────────────────────

/** Format seconds as MM:SS or H:MM:SS for the countdown display. */
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
 * Three ascending tones — no audio file required.
 * Returns a Promise that resolves when the chime finishes (~1.3 s).
 */
function _playChime() {
  return new Promise(resolve => {
    const ctx  = _getAudioCtx();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const notes = [
      { freq: 880,  start: 0.00, dur: 0.18 },  // A5
      { freq: 1046, start: 0.22, dur: 0.18 },  // C6
      { freq: 1318, start: 0.44, dur: 0.55 },  // E6 — held longer
    ];

    notes.forEach(({ freq, start, dur }) => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, ctx.currentTime + start);
      g.gain.linearRampToValueAtTime(0.22, ctx.currentTime + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(g);
      g.connect(gain);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    });

    setTimeout(resolve, 1300);
  });
}

// ── Timer creation ────────────────────────────────────────────────────────────

/**
 * Create a new countdown timer and add it to the panel.
 */
function _createTimer(totalSeconds, label) {
  const id        = _timerNextId++;
  const labelText = label
    ? label.charAt(0).toUpperCase() + label.slice(1)
    : `Timer ${id}`;

  // ── Build DOM entry ──────────────────────────────────────────────────────
  const entry = document.createElement('div');
  entry.className = 'timer-entry';
  entry.id        = `timer-entry-${id}`;

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

  // Cancel any pending auto-dismiss — a new timer is now active.
  if (_panelDismissTimer) { clearTimeout(_panelDismissTimer); _panelDismissTimer = null; }

  // Show the panel
  timerPanel.classList.remove('hidden');
  timerPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // ── Tick ────────────────────────────────────────────────────────────────
  let remaining = totalSeconds;
  const intervalId = setInterval(async () => {
    remaining--;

    const elapsed = totalSeconds - remaining;
    const pct     = Math.min(100, (elapsed / totalSeconds) * 100);
    progress.style.width = `${pct}%`;

    if (remaining > 0) {
      countdown.textContent = _fmtCountdown(remaining);
    } else {
      // ── Timer done ────────────────────────────────────────────────────
      clearInterval(intervalId);
      _timers.delete(id);

      countdown.textContent = 'DONE';
      entry.classList.add('done', 'pulsing');
      progress.style.width = '100%';

      // Remove pulse class after animation completes (~2.4 s)
      setTimeout(() => entry.classList.remove('pulsing'), 2500);

      // Schedule panel auto-dismiss after 8 s if no more active timers.
      _scheduleAutoDismiss();

      // Synthesise chime then speak announcement via Kokoro TTS
      await _playChime();
      const spoken = `Your ${_fmtDurationSpoken(totalSeconds)}${label ? ' ' + label : ''} timer is done.`;
      const { txt } = _appendMessage('assistant', spoken);
      _setState('speaking');
      _enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    }
  }, 1000);

  _timers.set(id, { id, label: labelText, totalSeconds, intervalId });
  return id;
}

// ── Timer cancellation ────────────────────────────────────────────────────────

/** Cancel or dismiss a specific timer by id. */
function _cancelTimer(id) {
  const t = _timers.get(id);
  if (t) {
    // Active timer — stop the interval and remove from state.
    clearInterval(t.intervalId);
    _timers.delete(id);
  }
  // Always remove the DOM entry (handles both active and completed timers).
  const entry = document.getElementById(`timer-entry-${id}`);
  if (entry) entry.remove();
  if (timerList.children.length === 0) timerPanel.classList.add('hidden');
}

/** Cancel all timers — wired to the "✕ ALL" button and the "cancel all timers" phrase. */
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
    const ids    = [..._timers.keys()];
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

// ── Public dismiss ────────────────────────────────────────────────────────────

/**
 * Dismiss the timer panel immediately if there are no active timers running.
 * Called from app.js when the user starts a new LLM conversation.
 */
export function dismissTimerPanel() {
  if (_timers.size > 0) return;  // active timers still running — leave panel visible
  if (_panelDismissTimer) { clearTimeout(_panelDismissTimer); }
  _dismissPanel();
}

// ── Public handler ────────────────────────────────────────────────────────────

/**
 * Handle a detected timer trigger. Speaks confirmation directly via TTS.
 * No LLM call is made.
 */
export function handleTimerTrigger(transcript, trigger) {
  if (trigger.action === 'cancel') {
    _appendMessage('user', transcript);

    if (trigger.label === 'all' || transcript.toLowerCase().includes('all')) {
      const count = _timers.size;
      _cancelAllTimers();
      const spoken = count > 0
        ? `Cancelled ${count} ${count === 1 ? 'timer' : 'timers'}.`
        : 'No active timers to cancel.';
      const { txt } = _appendMessage('assistant', spoken);
      _setState('speaking');
      _enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    } else {
      const found = _cancelTimerByLabel(trigger.label);
      const spoken = found ? 'Timer cancelled.' : 'No matching timer found.';
      const { txt } = _appendMessage('assistant', spoken);
      _setState('speaking');
      _enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    }
    return;
  }

  // action === 'set'
  const { durationSeconds, label } = trigger;
  _appendMessage('user', transcript);
  _createTimer(durationSeconds, label);

  const durationLabel = _fmtDurationSpoken(durationSeconds);
  const labelSuffix   = label ? ` ${label} timer` : ' timer';
  const spoken = `${durationLabel}${labelSuffix} set.`;
  const { txt } = _appendMessage('assistant', spoken);
  _setState('speaking');
  _enqueueSpeak(spoken, () => { txt.textContent = spoken; });
}
