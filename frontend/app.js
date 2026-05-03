// ── Config ────────────────────────────────────────────────────────────────────
const OLLAMA_BASE  = 'http://localhost:11434';
const BACKEND_BASE = 'http://localhost:8000';
const MODEL        = localStorage.getItem('remi_model') || 'llama3.1:8b';
const SYSTEM_PROMPT =
  'You are REMI (Responsive Embedded Machine Intelligence), a highly capable local AI assistant. Be concise, precise, and direct. Avoid unnecessary pleasantries.';

// ── Conversation state ────────────────────────────────────────────────────────
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const remiEl     = document.getElementById('remi');
const chatInner  = document.getElementById('chat-inner');
const micBtn     = document.getElementById('mic-btn');
const textInput  = document.getElementById('text-input');
const sendBtn    = document.getElementById('send-btn');
const clearBtn   = document.getElementById('clear-btn');
const ringIcon   = document.getElementById('ring-icon');
const ringState  = document.getElementById('ring-state');
const statModel  = document.getElementById('stat-model');
const statStatus = document.getElementById('stat-status');
const waveformEl = document.getElementById('waveform');

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
  ALL_STATE_CLASSES.forEach(c => remiEl.classList.remove(c));
  if (s.cls) remiEl.classList.add(s.cls);
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
  lbl.textContent = role === 'user' ? 'YOU' : 'R.E.M.I.';

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
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: conversationHistory,
        stream: true,
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

// ── Text-to-Speech (browser SpeechSynthesis) ─────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt   = new SpeechSynthesisUtterance(text);
  utt.rate    = 0.95;
  utt.pitch   = 0.8;
  utt.onstart = () => setState('speaking');
  utt.onend   = () => setState('idle');
  utt.onerror = () => setState('idle');
  window.speechSynthesis.speak(utt);
}

// ── Text send handler ─────────────────────────────────────────────────────────
async function handleSend() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  appendMessage('user', text);
  const response = await sendToOllama(text);
  if (response) speak(response);
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
      setState('transcribing');

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const form = new FormData();
      form.append('audio', blob, 'recording.webm');

      try {
        const r = await fetch(`${BACKEND_BASE}/transcribe/`, { method: 'POST', body: form });
        if (!r.ok) throw new Error(`STT ${r.status}`);
        const { transcript } = await r.json();
        if (!transcript) { setState('idle'); return; }
        appendMessage('user', transcript);
        const response = await sendToOllama(transcript);
        if (response) speak(response);
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
appendMessage('assistant',
  `All systems nominal. REMI online — running ${MODEL} on GPU via Ollama. How can I assist?`);
setState('idle');
