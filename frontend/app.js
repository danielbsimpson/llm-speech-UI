// ── Config ────────────────────────────────────────────────────────────────────
const OLLAMA_BASE  = 'http://localhost:11434';
const BACKEND_BASE = 'http://localhost:8000';
const MODEL        = localStorage.getItem('starling_model') || 'llama3.1:8b';
const SYSTEM_PROMPT =
  'You are S.T.A.R.L.I.N.G. (Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator), a highly capable local AI assistant. Be concise, precise, and direct. Avoid unnecessary pleasantries.';

// ── Conversation state ────────────────────────────────────────────────────────
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const starlingEl  = document.getElementById('starling');
const chatInner   = document.getElementById('chat-inner');
const micBtn      = document.getElementById('mic-btn');
const textInput   = document.getElementById('text-input');
const sendBtn     = document.getElementById('send-btn');
const clearBtn    = document.getElementById('clear-btn');
const ringIcon    = document.getElementById('ring-icon');
const ringState   = document.getElementById('ring-state');
const statModel   = document.getElementById('stat-model');
const statStatus  = document.getElementById('stat-status');
const waveformEl  = document.getElementById('waveform');
const ttsToggle   = document.getElementById('tts-toggle');
const voiceSelect = document.getElementById('voice-select');
const ttsEngineEl = document.getElementById('tts-engine');
const ftrTts      = document.getElementById('ftr-tts');
const ftrWhisperDev = document.getElementById('ftr-whisper-dev');
const ftrKokoroDev  = document.getElementById('ftr-kokoro-dev');
const ftrOllamaDev  = document.getElementById('ftr-ollama-dev');

// ── System status ────────────────────────────────────────────────────────────
async function fetchSystemStatus() {
  try {
    const res = await fetch(`${BACKEND_BASE}/system-status`);
    if (!res.ok) return;
    const { whisper, kokoro, ollama } = await res.json();
    function setDev(el, val) {
      if (!el) return;
      el.textContent = val;
      el.dataset.dev  = val;
    }
    setDev(ftrWhisperDev, whisper);
    setDev(ftrKokoroDev,  kokoro);
    setDev(ftrOllamaDev,  ollama);
  } catch { /* backend offline — ignore */ }
}

// ── Waveform bars ─────────────────────────────────────────────────────────────
const BAR_COUNT = 40;
const bars = Array.from({ length: BAR_COUNT }, () => {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = (Math.random() * 6 + 4) + 'px';
  waveformEl.appendChild(b);
  return b;
});

// Idle sine-wave animation
let idleActive = true;
function idleTick() {
  if (!idleActive) return;
  const t = Date.now() / 1000;
  bars.forEach((b, i) => {
    b.style.height = (Math.sin(t * 1.1 + i * 0.38) * 5 + 7) + 'px';
  });
  requestAnimationFrame(idleTick);
}
idleTick();

// Real audio-level visualizer during recording
let analyserRaf = null;
function startAudioViz(stream) {
  idleActive = false;
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an  = ctx.createAnalyser();
  an.fftSize = 128;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  function tick() {
    an.getByteFrequencyData(data);
    bars.forEach((b, i) => {
      const v = data[Math.floor(i * data.length / bars.length)] / 255;
      b.style.height = (v * 28 + 3) + 'px';
    });
    analyserRaf = requestAnimationFrame(tick);
  }
  tick();
}
function stopAudioViz() {
  cancelAnimationFrame(analyserRaf);
  idleActive = true;
  idleTick();
}

// ── UI state machine ──────────────────────────────────────────────────────────
const STATE_CFG = {
  idle:         { cls: null,              icon: '🎙', label: 'READY',        status: 'ONLINE'  },
  listening:    { cls: 'state-listening', icon: '👂', label: 'LISTENING',    status: 'HEARING' },
  transcribing: { cls: 'state-thinking',  icon: '⚙️', label: 'TRANSCRIBING', status: 'PROC...' },
  thinking:     { cls: 'state-thinking',  icon: '⚙️', label: 'THINKING',     status: 'PROC...' },
  speaking:     { cls: 'state-speaking',  icon: '🔊', label: 'SPEAKING',     status: 'ONLINE'  },
  error:        { cls: 'state-error',     icon: '⚠️', label: 'ERROR',        status: 'ERROR'   },
};
const ALL_STATE_CLASSES = ['state-listening', 'state-thinking', 'state-speaking', 'state-error'];

function setState(name) {
  const s = STATE_CFG[name] ?? STATE_CFG.idle;
  ALL_STATE_CLASSES.forEach(c => starlingEl.classList.remove(c));
  if (s.cls) starlingEl.classList.add(s.cls);
  ringIcon.textContent   = s.icon;
  ringState.textContent  = s.label;
  statStatus.textContent = s.status;
}

// ── Append message ────────────────────────────────────────────────────────────
function appendMessage(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role === 'user' ? 'user' : 'asst'}`;

  const lbl = document.createElement('span');
  lbl.className   = 'msg-lbl';
  lbl.textContent = role === 'user' ? 'YOU' : 'S.T.A.R.L.I.N.G.';

  const txt = document.createElement('span');
  txt.className   = 'msg-text';
  txt.textContent = content;

  wrap.appendChild(lbl);
  wrap.appendChild(txt);
  chatInner.appendChild(wrap);
  chatInner.scrollTop = chatInner.scrollHeight;
  return { wrap, txt };
}

// ── Ollama streaming chat ─────────────────────────────────────────────────────
async function sendToOllama(userText) {
  conversationHistory.push({ role: 'user', content: userText });

  const { wrap, txt } = appendMessage('assistant', '');
  wrap.classList.add('streaming');
  setState('thinking');

  try {
    const res = await fetch(`${BACKEND_BASE}/chat/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: conversationHistory,
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const token = JSON.parse(line)?.message?.content ?? '';
          full += token;
          txt.textContent = full;
          chatInner.scrollTop = chatInner.scrollHeight;
        } catch { /* partial JSON chunk — skip */ }
      }
    }

    wrap.classList.remove('streaming');
    conversationHistory.push({ role: 'assistant', content: full });
    setState('idle');
    return full;
  } catch (err) {
    wrap.classList.remove('streaming');
    txt.textContent = `[Error: ${err.message}]`;
    setState('error');
    setTimeout(() => setState('idle'), 4000);
    return null;
  }
}

// ── Text-to-Speech ────────────────────────────────────────────────────────────
// State: 'kokoro' | 'browser' | 'off'
let ttsMode  = localStorage.getItem('starling_tts_mode') || 'kokoro';
let ttsVoice = localStorage.getItem('starling_tts_voice') || 'bm_george';

function _applyTtsMode() {
  if (ttsMode === 'off') {
    ttsToggle.textContent    = 'TTS OFF';
    ttsToggle.classList.add('tts-off');
    voiceSelect.disabled     = true;
    ttsEngineEl.textContent  = 'OFF';
    if (ftrTts) ftrTts.textContent = 'Off';
  } else if (ttsMode === 'browser') {
    ttsToggle.textContent    = 'TTS: BROWSER';
    ttsToggle.classList.remove('tts-off');
    voiceSelect.disabled     = true;
    ttsEngineEl.textContent  = 'BROWSER';
    if (ftrTts) ftrTts.textContent = 'Web Speech';
  } else {
    ttsToggle.textContent    = 'TTS: KOKORO';
    ttsToggle.classList.remove('tts-off');
    voiceSelect.disabled     = false;
    ttsEngineEl.textContent  = 'KOKORO';
    if (ftrTts) ftrTts.textContent = 'Kokoro (local)';
  }
}

// Cycle: kokoro → browser → off → kokoro
ttsToggle.addEventListener('click', () => {
  ttsMode = ttsMode === 'kokoro' ? 'browser' : ttsMode === 'browser' ? 'off' : 'kokoro';
  localStorage.setItem('starling_tts_mode', ttsMode);
  _applyTtsMode();
});

voiceSelect.addEventListener('change', () => {
  ttsVoice = voiceSelect.value;
  localStorage.setItem('starling_tts_voice', ttsVoice);
});

// Populate voice dropdown from /synthesize/voices
async function loadVoices() {
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/voices`);
    if (!res.ok) return;
    const voices = await res.json();
    voiceSelect.innerHTML = '';
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value       = v.id;
      opt.textContent = v.label;
      if (v.id === ttsVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
    // Ensure stored voice still exists; fall back to first option
    if (!voices.find(v => v.id === ttsVoice)) {
      ttsVoice = voices[0]?.id || 'bm_george';
      voiceSelect.value = ttsVoice;
      localStorage.setItem('starling_tts_voice', ttsVoice);
    }
  } catch { /* backend not running — leave static fallback option */ }
}

// Active audio element (so we can cancel mid-speech)
let _activeAudio = null;

async function _speakKokoro(text) {
  setState('speaking');
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice, speed: 1.0 }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _activeAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); _activeAudio = null; setState('idle'); };
    audio.onerror = () => { URL.revokeObjectURL(url); _activeAudio = null; setState('idle'); };
    await audio.play();
  } catch (err) {
    console.warn('Kokoro TTS failed, falling back to browser SpeechSynthesis:', err);
    _speakBrowser(text);
  }
}

function _speakBrowser(text) {
  if (!window.speechSynthesis) { setState('idle'); return; }
  window.speechSynthesis.cancel();
  const utt   = new SpeechSynthesisUtterance(text);
  utt.rate    = 0.95;
  utt.pitch   = 0.8;
  utt.onstart = () => setState('speaking');
  utt.onend   = () => setState('idle');
  utt.onerror = () => setState('idle');
  window.speechSynthesis.speak(utt);
}

function stopSpeaking() {
  if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  setState('idle');
}

async function speak(text) {
  if (ttsMode === 'off') return;
  if (ttsMode === 'browser') { _speakBrowser(text); return; }
  await _speakKokoro(text);
}

// ── Text send handler ─────────────────────────────────────────────────────────
async function handleSend() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  appendMessage('user', text);
  const response = await sendToOllama(text);
  if (response) {
    await speak(response);
    fetchSystemStatus();
  }
}

sendBtn.addEventListener('click', handleSend);
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});

// ── Clear conversation ────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatInner.innerHTML = '';
  setState('idle');
});

// ── MediaRecorder → Whisper STT ───────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];

async function startRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return; // guard
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startAudioViz(stream);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : '';
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    audioChunks   = [];

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      stopAudioViz();
      stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1024) {
        setState('idle');   // recording was too short / empty — silently ignore
        return;
      }

      setState('transcribing');

      const form = new FormData();
      form.append('audio', blob, 'recording.webm');

      try {
        const r = await fetch(`${BACKEND_BASE}/transcribe/`, { method: 'POST', body: form });
        if (!r.ok) throw new Error(`STT ${r.status}`);
        const { transcript } = await r.json();
        if (!transcript) { setState('idle'); return; }
        appendMessage('user', transcript);
        const response = await sendToOllama(transcript);
        if (response) {
          await speak(response);
          fetchSystemStatus();
        }
      } catch (err) {
        appendMessage('assistant', `[STT error: ${err.message}]`);
        setState('error');
        setTimeout(() => setState('idle'), 4000);
      }
    };

    mediaRecorder.start();
    micBtn.classList.add('recording');
    setState('listening');
  } catch (err) {
    appendMessage('assistant', `[Mic error: ${err.message}]`);
    setState('error');
    setTimeout(() => setState('idle'), 4000);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    micBtn.classList.remove('recording');
  }
}

// Push-to-talk — mouse
micBtn.addEventListener('mousedown', startRecording);
micBtn.addEventListener('mouseup',   stopRecording);
micBtn.addEventListener('mouseleave', stopRecording);

// Push-to-talk — touch
micBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
micBtn.addEventListener('touchend',   e => { e.preventDefault(); stopRecording();  });

// Push-to-talk — spacebar (only when text input is not focused)
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.activeElement !== textInput && !e.repeat) {
    e.preventDefault();
    startRecording();
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && document.activeElement !== textInput) {
    e.preventDefault();
    stopRecording();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
statModel.textContent = MODEL;
_applyTtsMode();
loadVoices();
appendMessage('assistant',
  `All systems nominal. S.T.A.R.L.I.N.G. online — running ${MODEL} on GPU via Ollama. How can I assist?`);
setState('idle');
