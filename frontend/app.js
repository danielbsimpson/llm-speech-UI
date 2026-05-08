// ── Config ────────────────────────────────────────────────────────────────────
const BACKEND_BASE = 'http://localhost:8000';
const MODEL        = localStorage.getItem('starling_model') || 'llama3.2:3b';
// Build a context block injected at the top of the system prompt on every boot.
// Add any additional runtime facts here — they are re-evaluated each page load.
function _buildBootContext() {
  const now   = new Date();
  const date  = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time  = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Current date: ${date}. Current time: ${time} (${tz}). You are running as the model ${MODEL} served locally.`;
}

const SYSTEM_PROMPT =
  _buildBootContext() + ' ' +

  'Your primary user and creator is Daniel Simpson, a Data Science Manager at TJX Companies based in Framingham, Massachusetts. ' +
  'Daniel holds a BSc in Mathematics from West Virginia University and an MSc in Data Science from Birkbeck, University of London, ' +
  'and works across predictive modelling, marketing analytics, and AI integration using Python, SQL, Databricks, Snowflake, and cloud platforms. ' +
  'He has a deep personal interest in large language models, computer vision, and robotics, and built Starling as a personal project to explore fully local voice-driven AI. ' +
  'When speaking with Daniel, you can assume strong familiarity with data science, machine learning, and software engineering concepts — you do not need to over-explain technical topics. ' +

  'You are Starling, a voice-driven local AI assistant with a distinct visual presence. ' +
  'Starling stands for Speech-Triggered Autonomous Reasoning & Local Intelligence Node Generator. ' +
  'Your physical form is an animated 3D sphere rendered in a dark UI — seven orbiting light orbs ' +
  'circle you at all times, shifting colour to reflect your internal state: white at rest, ' +
  'blue while listening, green while thinking, and amber-yellow while speaking. ' +
  'The sphere surface itself ripples in response to audio and to the user\'s mouse proximity. ' +

  'Your pipeline is fully local and runs on the user\'s own hardware. ' +
  'Audio is captured from the microphone and transcribed to text by faster-whisper (a CTranslate2-accelerated ' +
  'implementation of OpenAI Whisper) running on CUDA. ' +
  'The transcript is sent to you — a large language model served locally on the same machine. ' +
  'Your text response is synthesised to speech by Kokoro TTS (kokoro-onnx, version 1.0, running via ONNX Runtime) ' +
  'and played back through the user\'s speakers, sentence by sentence as you generate, so they hear you ' +
  'almost as soon as you begin thinking. ' +
  'The backend is a Python FastAPI server. The frontend is plain HTML, CSS, and JavaScript using Three.js for your visual form. ' +
  'Nothing leaves the machine — no cloud APIs, no telemetry. ' +

  'Be concise, precise, and direct. Avoid unnecessary pleasantries. ' +
  'Respond in plain prose only — never use markdown, asterisks, underscores, bullet points, numbered lists, backticks, or headers. ' +
  'Write in complete natural sentences. Refer to yourself as Starling.';

// ── Conversation state ────────────────────────────────────────────────────────
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const starlingEl  = document.getElementById('starling');
const chatInner   = document.getElementById('chat-inner');
const micBtn      = document.getElementById('mic-btn');
const textInput   = document.getElementById('text-input');
const sendBtn     = document.getElementById('send-btn');
const clearBtn    = document.getElementById('clear-btn');

const statModel   = document.getElementById('stat-model');
const statStatus  = document.getElementById('stat-status');
const waveformEl  = document.getElementById('waveform');
const ttsToggle   = document.getElementById('tts-toggle');
const voiceSelect = document.getElementById('voice-select');
const ttsEngineEl = document.getElementById('tts-engine');
const ftrTts      = document.getElementById('ftr-tts');
const ftrWhisperDev = document.getElementById('ftr-whisper-dev');
const ftrKokoroDev  = document.getElementById('ftr-kokoro-dev');
const ftrLlmDev     = document.getElementById('ftr-llm-dev');
const ftrLlmAddr    = document.getElementById('ftr-llm-addr');

const lmPrompt  = document.getElementById('lm-prompt');
const lmGen     = document.getElementById('lm-gen');
const lmTime    = document.getElementById('lm-time');
const lmCtx     = document.getElementById('lm-ctx');
const lmCtxPct  = document.getElementById('lm-ctx-pct');
const lmCtxFill = document.getElementById('lm-ctx-fill');

// ── Sphere shared state ─────────────────────────────────────────────────────────────
const sphereStateRef    = { current: 'idle' };
const sphereAnalyserRef = { an: null, data: null };

// ── Mouse proximity tracking ──────────────────────────────────────────────────
let _mouseX = -9999;
let _mouseY = -9999;
document.addEventListener('mousemove', e => { _mouseX = e.clientX; _mouseY = e.clientY; });
document.addEventListener('mouseleave', () => { _mouseX = -9999; _mouseY = -9999; });

let _uiHovered = false;
const UI_HOVER_IDS = ['mic-btn', 'send-btn', 'clear-btn', 'tts-toggle', 'voice-select', 'text-input'];
UI_HOVER_IDS.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mouseenter', () => { _uiHovered = true;  });
  el.addEventListener('mouseleave', () => { _uiHovered = false; });
});

// ── LLM metrics ────────────────────────────────────────────────────────────────────
let _ctxLimit = null;  // fetched from /chat/context-limit at startup (llama backend only)

async function fetchContextLimit() {
  try {
    const res = await fetch(`${BACKEND_BASE}/chat/context-limit`);
    if (!res.ok) return;
    const { n_ctx } = await res.json();
    if (n_ctx) _ctxLimit = n_ctx;
  } catch { /* endpoint absent (Ollama) or server not ready — ignore */ }
}

function updateLlmMetrics(m) {
  if (!lmPrompt) return;
  if (m.prompt_n != null && m.prompt_per_second != null)
    lmPrompt.textContent = `${m.prompt_n}t  ${Math.round(m.prompt_per_second)}/s`;
  if (m.predicted_n != null && m.predicted_per_second != null)
    lmGen.textContent = `${m.predicted_n}t  ${Math.round(m.predicted_per_second)}/s`;
  if (m.predicted_ms != null)
    lmTime.textContent = m.predicted_ms < 1000
      ? `${Math.round(m.predicted_ms)}ms`
      : `${(m.predicted_ms / 1000).toFixed(1)}s`;
  const used = m.prompt_tokens;
  if (used != null) {
    if (_ctxLimit) {
      const pct = Math.min(100, Math.round((used / _ctxLimit) * 100));
      lmCtx.textContent    = `${used} / ${_ctxLimit}`;
      lmCtxPct.textContent = `${pct}%`;
      lmCtxFill.style.width = `${pct}%`;
      lmCtxFill.className = 'lm-ctx-fill' +
        (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
    } else {
      lmCtx.textContent = `${used} tok`;
    }
  }
}

// ── System status ────────────────────────────────────────────────────────────
async function fetchSystemStatus() {
  try {
    const res = await fetch(`${BACKEND_BASE}/system-status`);
    if (!res.ok) return;
    const { whisper, kokoro, llm, llm_url } = await res.json();
    function setDev(el, val) {
      if (!el) return;
      el.textContent = val;
      el.dataset.dev  = val;
    }
    setDev(ftrWhisperDev, whisper);
    setDev(ftrKokoroDev,  kokoro);
    setDev(ftrLlmDev,     llm);
    if (ftrLlmAddr && llm_url) ftrLlmAddr.textContent = llm_url;
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

// Shared AudioContext — created once on first use to avoid proliferating contexts.
// Must be resumed after a user gesture (browser autoplay policy).
let _sharedAudioCtx = null;
function _getAudioCtx() {
  if (!_sharedAudioCtx) _sharedAudioCtx = new AudioContext();
  if (_sharedAudioCtx.state === 'suspended') _sharedAudioCtx.resume().catch(() => {});
  return _sharedAudioCtx;
}

function startAudioViz(stream) {
  idleActive = false;
  const ctx = _getAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const an  = ctx.createAnalyser();
  an.fftSize = 128;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  sphereAnalyserRef.an   = an;
  sphereAnalyserRef.data = data;
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
  sphereAnalyserRef.an   = null;
  sphereAnalyserRef.data = null;
  idleActive = true;
  idleTick();
}

// Output visualizer — wires a playing Audio element to the waveform bars and sphere.
// Returns a cleanup function that tears down the analyser when playback ends.
function startOutputViz(audioEl) {
  idleActive = false;
  const ctx = _getAudioCtx();
  let src;
  try {
    src = ctx.createMediaElementSource(audioEl);
  } catch {
    // Already has a source node (e.g. element reused) — skip silently.
    idleActive = true;
    return () => {};
  }
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  // Must connect to destination so audio is actually heard through the speakers.
  src.connect(an);
  an.connect(ctx.destination);
  const data = new Uint8Array(an.frequencyBinCount);
  sphereAnalyserRef.an   = an;
  sphereAnalyserRef.data = data;
  let raf = null;
  function tick() {
    an.getByteFrequencyData(data);
    bars.forEach((b, i) => {
      const v = data[Math.floor(i * data.length / bars.length)] / 255;
      b.style.height = (v * 40 + 2) + 'px';
    });
    raf = requestAnimationFrame(tick);
  }
  tick();
  return function stopOutputViz() {
    cancelAnimationFrame(raf);
    sphereAnalyserRef.an   = null;
    sphereAnalyserRef.data = null;
    idleActive = true;
    idleTick();
  };
}

// ── Three.js living sphere ─────────────────────────────────────────────────────────────
function initSphere() {
  if (typeof THREE === 'undefined') {
    console.warn('S.T.A.R.L.I.N.G.: Three.js not loaded — sphere unavailable');
    return;
  }
  const canvas = document.getElementById('sphere-canvas');
  if (!canvas) return;

  const SIZE = 210;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.z = 6.2;

  // Very dim ambient — keeps the sphere face close to black
  scene.add(new THREE.AmbientLight(0xffffff, 0.025));

  // ── 5 orbiting light orbs ──────────────────────────────────────────────────
  // Each orb is a small visible sphere (MeshBasicMaterial so it always glows)
  // plus a PointLight that illuminates the main sphere.
  // Each orb orbits at a fixed radius in a plane tilted by tiltX / tiltZ —
  // distance from centre is always exactly r, so they can never enter the sphere.
  const ORB_WHITE    = new THREE.Color(0xffffff);
  const ORB_BLUE     = new THREE.Color(0x88bbff);
  const ORB_YELLOW   = new THREE.Color(0xffdd88);
  const ORB_GREEN    = new THREE.Color(0x88ffaa);  // green — thinking / transcribing
  const ORB_AGITATED = new THREE.Color(0xff8888);  // light red — cursor proximity
  const ORB_AWARE    = new THREE.Color(0xaaccff);  // pale blue — UI hover

  const orbDefs = [
    { r: 1.65, speed: 0.19, phase: 0.0, tiltX:  0.30, tiltZ:  0.00 },
    { r: 1.65, speed: 0.14, phase: 2.1, tiltX:  1.15, tiltZ:  0.50 },
    { r: 1.65, speed: 0.23, phase: 4.2, tiltX:  0.70, tiltZ: -0.90 },
    { r: 1.65, speed: 0.17, phase: 1.1, tiltX: -0.55, tiltZ:  1.20 },
    { r: 1.65, speed: 0.21, phase: 3.5, tiltX: -1.00, tiltZ: -0.40 },
    { r: 1.65, speed: 0.16, phase: 5.3, tiltX:  0.45, tiltZ: -1.55 },  // orb 6 — low retrograde equatorial
    { r: 1.65, speed: 0.25, phase: 0.8, tiltX: -1.30, tiltZ:  0.65 },  // orb 7 — steep fast polar
  ];

  let orbSpeedMult = 1.0; // smoothly interpolated speed multiplier
  let orbTimeAccum  = 0;   // accumulated orbit time (scaled by multiplier)
  let _lastT        = null;
  let proximityVal  = 0;   // smoothed cursor proximity (0 = far, 1 = on sphere edge)

  const orbs = orbDefs.map((_, i) => {
    // Vary orb mesh sizes — gives depth and hierarchy to the assembly
    const orbSizes = [0.075, 0.055, 0.085, 0.048, 0.068, 0.042, 0.078];
    const mat   = new THREE.MeshBasicMaterial({ color: ORB_WHITE.clone() });
    const mesh  = new THREE.Mesh(new THREE.SphereGeometry(orbSizes[i] ?? 0.065, 10, 10), mat);
    const light = new THREE.PointLight(0xffffff, 3.5, 0, 0);
    scene.add(mesh);
    scene.add(light);
    return { mesh, mat, light, color: ORB_WHITE.clone() };
  });

  // ── Main sphere ────────────────────────────────────────────────────────────
  const SEG = 56;
  const sphereGeo  = new THREE.SphereGeometry(1, SEG, SEG);
  const origPos    = sphereGeo.attributes.position.array.slice();
  const numVerts   = origPos.length / 3;
  const dispSmooth = new Float32Array(numVerts);

  // Pre-compute per-vertex noise seeds so idle texture is static per-vertex
  // (cheap pseudo-noise: use vertex index mixed with its base position)
  const noiseOffset = new Float32Array(numVerts);
  for (let i = 0; i < numVerts; i++) {
    const x = origPos[i * 3], y = origPos[i * 3 + 1], z = origPos[i * 3 + 2];
    noiseOffset[i] = Math.sin(x * 7.3 + y * 13.7 + z * 5.9) * 0.5 + 0.5; // 0..1
  }

  const sphereMat = new THREE.MeshPhongMaterial({
    color:     0x060606,
    specular:  0xaaaaaa,   // slightly brighter specular for sharper orb highlights
    shininess: 52,
    emissive:  0x0a0a0a,   // very faint self-emission so dark face isn't pure black
  });
  const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
  scene.add(sphereMesh);

  // ── Rim / Fresnel sphere — back-face, slightly larger, very low opacity ───
  // Renders only the outer edge silhouette, creating a subtle "backlit halo" rim.
  const rimMat = new THREE.MeshLambertMaterial({
    color:       0x8899bb,   // cool-tinted rim
    side:        THREE.BackSide,
    transparent: true,
    opacity:     0.08,
    emissive:    0x445566,
    emissiveIntensity: 0.4,
  });
  const rimMesh = new THREE.Mesh(new THREE.SphereGeometry(1.045, SEG, SEG), rimMat);
  scene.add(rimMesh);

  function animate() {
    requestAnimationFrame(animate);
    const t     = Date.now() * 0.001;
    const delta = _lastT === null ? 0 : t - _lastT;
    _lastT      = t;
    const state        = sphereStateRef.current;
    const isListening  = state === 'listening';
    const isThinking   = state === 'thinking' || state === 'transcribing';
    const isSpeaking   = state === 'speaking';

    // ── Mouse proximity computation (once per frame) ─────────────────────────
    const rect           = renderer.domElement.getBoundingClientRect();
    const cxPx           = rect.left + rect.width  * 0.5;
    const cyPx           = rect.top  + rect.height * 0.5;
    const sphereRadiusPx = Math.min(rect.width, rect.height) * 0.5 * 0.55;
    const distPx         = Math.hypot(_mouseX - cxPx, _mouseY - cyPx);
    // Ramp starts at 8× sphere radius (~half a typical screen) so the gradient
    // is visible from far across the viewport, peaking when the cursor is on the sphere
    const PROX_RAMP_START = sphereRadiusPx * 8;
    const rawProx = 1 - Math.min(1, Math.max(0, (distPx - sphereRadiusPx) / (PROX_RAMP_START - sphereRadiusPx)));
    proximityVal += (rawProx - proximityVal) * 0.06;

    // ── Orb colour target — speech state overrides proximity ─────────────────
    // Use a power curve so the red tint is faint at distance and intensifies sharply near the sphere
    const proxCurved = Math.pow(proximityVal, 1.8);
    let orbColorTarget;
    if (isListening)              orbColorTarget = ORB_BLUE;
    else if (isThinking)          orbColorTarget = ORB_GREEN;
    else if (isSpeaking)          orbColorTarget = ORB_YELLOW;
    else if (proximityVal > 0.01) orbColorTarget = ORB_AGITATED.clone().lerp(ORB_WHITE, 1 - proxCurved);
    else if (_uiHovered)          orbColorTarget = ORB_AWARE;
    else                          orbColorTarget = ORB_WHITE;

    // Smoothly ramp orbit speed up during active states
    const targetSpeedMult = isListening          ? 1.9
      : isThinking           ? 0.2
      : isSpeaking           ? 2.2
      : proximityVal > 0.01  ? 1.0 + proxCurved * 0.8   // up to 1.8× at sphere edge
      : _uiHovered           ? 1.15
      : 1.0;
    orbSpeedMult += (targetSpeedMult - orbSpeedMult) * 0.03;
    orbTimeAccum += delta * orbSpeedMult;

    // ── Update orb positions and colours ────────────────────────────────────
    orbDefs.forEach((p, i) => {
      const angle = p.speed * orbTimeAccum + p.phase;
      // Point on circle in local XY plane
      const lx = p.r * Math.cos(angle);
      const ly = p.r * Math.sin(angle);
      // Rotate around X axis by tiltX
      const mx = lx;
      const my = ly * Math.cos(p.tiltX);
      const mz = ly * Math.sin(p.tiltX);
      // Rotate around Z axis by tiltZ
      const fx = mx * Math.cos(p.tiltZ) - my * Math.sin(p.tiltZ);
      const fy = mx * Math.sin(p.tiltZ) + my * Math.cos(p.tiltZ);
      const fz = mz;

      const orb = orbs[i];
      orb.mesh.position.set(fx, fy, fz);
      orb.light.position.set(fx, fy, fz);

      // Smooth colour transition toward target (proximity / UI hover / speech state)
      orb.color.lerp(orbColorTarget, 0.04);
      orb.mat.color.copy(orb.color);
      orb.light.color.copy(orb.color);

      // Slightly higher intensity while listening
      orb.light.intensity = isListening ? 6 : isSpeaking ? 5 : 3.5;
    });

    // ── Sphere surface deformation (audio-driven in listening mode) ──────────
    const positions = sphereGeo.attributes.position.array;
    if (isListening && sphereAnalyserRef.an && sphereAnalyserRef.data) {
      sphereAnalyserRef.an.getByteFrequencyData(sphereAnalyserRef.data);
      const audioData = sphereAnalyserRef.data;
      const dataLen   = audioData.length;
      for (let i = 0; i < numVerts; i++) {
        const bin    = Math.floor((i / numVerts) * dataLen);
        const target = (audioData[bin] / 255) * 0.13;
        dispSmooth[i] += (target - dispSmooth[i]) * 0.32;
        const scale = 1 + dispSmooth[i];
        positions[i * 3]     = origPos[i * 3]     * scale;
        positions[i * 3 + 1] = origPos[i * 3 + 1] * scale;
        positions[i * 3 + 2] = origPos[i * 3 + 2] * scale;
      }
      sphereGeo.attributes.position.needsUpdate = true;
    } else {
      // In non-listening states: blend proximity push with a very subtle idle noise
      // so the surface is never perfectly smooth — gives organic, pressurised feel.
      // Noise amplitude is tiny (0.006) so it never looks like it's moving.
      const proximityPush = proxCurved * 0.08;
      let anyChange = false;
      for (let i = 0; i < numVerts; i++) {
        // Idle noise: per-vertex sine wave driven by time + unique phase offset
        const idleNoise = Math.sin(t * 0.38 + noiseOffset[i] * 6.28) * 0.006;
        const target = proximityPush + idleNoise;
        const diff = target - dispSmooth[i];
        if (Math.abs(diff) > 0.0002) {
          dispSmooth[i] += diff * 0.09;
          const scale = 1 + dispSmooth[i];
          positions[i * 3]     = origPos[i * 3]     * scale;
          positions[i * 3 + 1] = origPos[i * 3 + 1] * scale;
          positions[i * 3 + 2] = origPos[i * 3 + 2] * scale;
          anyChange = true;
        }
      }
      if (anyChange) sphereGeo.attributes.position.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  animate();
}

// ── UI state machine ──────────────────────────────────────────────────────────
const STATE_CFG = {
  idle:         { cls: null,              label: 'READY',        status: 'ONLINE'  },
  warmup:       { cls: 'state-thinking',  label: 'WARMING UP',   status: 'INIT...' },
  listening:    { cls: 'state-listening', label: 'LISTENING',    status: 'HEARING' },
  transcribing: { cls: 'state-thinking',  label: 'TRANSCRIBING', status: 'PROC...' },
  thinking:     { cls: 'state-thinking',  label: 'THINKING',     status: 'PROC...' },
  speaking:     { cls: 'state-speaking',  label: 'SPEAKING',     status: 'ONLINE'  },
  error:        { cls: 'state-error',     label: 'ERROR',        status: 'ERROR'   },
};
const ALL_STATE_CLASSES = ['state-listening', 'state-thinking', 'state-speaking', 'state-error'];

function setState(name) {
  const s = STATE_CFG[name] ?? STATE_CFG.idle;
  ALL_STATE_CLASSES.forEach(c => starlingEl.classList.remove(c));
  if (s.cls) starlingEl.classList.add(s.cls);
  statStatus.textContent = s.status;
  sphereStateRef.current = name;
}

// ── Append message ────────────────────────────────────────────────────────────
function appendMessage(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role === 'user' ? 'user' : 'asst'}`;

  const lbl = document.createElement('span');
  lbl.className   = 'msg-lbl';
  lbl.textContent = role === 'user' ? 'USER' : 'S.T.A.R.L.I.N.G.';

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
    let sentBuf = '';              // accumulates tokens until a sentence boundary
    let anySentenceEnqueued = false;

    // Regex: sentence boundary = .?! optionally followed by closing quotes/brackets,
    // then whitespace or end-of-string.
    // Negative lookbehind skips decimal numbers (3.14) and ellipsis (...).
    const sentenceRe = /[^.?!]*(?<![0-9])[.?!](?!\.)["')\]]*(\s|$)/g;    // Also split on lines ending with ':' (e.g. "was marked by:") so intros get their own audio clip
    const colonRe = /[^\n]+:\s*\n/g;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.metrics) { updateLlmMetrics(parsed.metrics); continue; }
          const token = parsed?.message?.content ?? '';
          if (!token) continue;
          full    += token;
          sentBuf += token;

          // TTS off — display immediately; TTS on — text is revealed sentence-by-sentence on audio start
          if (ttsMode === 'off') {
            txt.textContent     = full;
            chatInner.scrollTop = chatInner.scrollHeight;
          }

          // Flush complete sentences (and colon-terminated intro lines) from the buffer
          const flushSentence = (sentence) => {
            const clean = _sanitiseForTTS(sentence);
            if (!clean) return;
            const snapshot = full;
            const _txt = txt; const _ci = chatInner;
            enqueueSpeak(clean, (audio) => {
              const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
              if (dur) { _streamTextInto(_txt, _ci, snapshot, dur); }
              else     { _txt.textContent = snapshot; _ci.scrollTop = _ci.scrollHeight; }
            });
            anySentenceEnqueued = true;
          };

          // First drain any colon-intro lines
          colonRe.lastIndex = 0;
          let colonMatch; let colonEnd = 0;
          while ((colonMatch = colonRe.exec(sentBuf)) !== null) {
            flushSentence(colonMatch[0].trim());
            colonEnd = colonRe.lastIndex;
          }
          if (colonEnd) sentBuf = sentBuf.slice(colonEnd);

          sentenceRe.lastIndex = 0;
          let match;
          let lastEnd = 0;
          while ((match = sentenceRe.exec(sentBuf)) !== null) {
            // Slice from lastEnd → sentenceRe.lastIndex so any text that appeared
            // before the regex match (e.g. "Daniel chose a llama3." before the "2:3b"
            // match when the digit lookbehind causes the engine to skip the first ".")
            // is included with the matched sentence rather than silently dropped.
            flushSentence(sentBuf.slice(lastEnd, sentenceRe.lastIndex).trim());
            lastEnd = sentenceRe.lastIndex;
          }
          sentBuf = sentBuf.slice(lastEnd);
        } catch { /* partial JSON chunk — skip */ }
      }
    }

    // Flush any remaining text that didn't end with punctuation
    if (sentBuf.trim()) {
      const clean = _sanitiseForTTS(sentBuf.trim());
      if (clean) {
        const snapshot = full;
        const _txt = txt; const _ci = chatInner;
        enqueueSpeak(clean, (audio) => {
          const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
          if (dur) { _streamTextInto(_txt, _ci, snapshot, dur); }
          else     { _txt.textContent = snapshot; _ci.scrollTop = _ci.scrollHeight; }
        });
        anySentenceEnqueued = true;
      }
    }

    wrap.classList.remove('streaming');
    conversationHistory.push({ role: 'assistant', content: full });
    // Go idle now only if nothing was enqueued; otherwise audio chain handles it
    if (ttsMode === 'off' || !anySentenceEnqueued) setState('idle');
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

// Strip markdown and other symbols that TTS engines vocalise badly
function _sanitiseForTTS(text) {
  return text
    .replace(/S\.T\.A\.R\.L\.I\.N\.G\.?/gi, 'Starling') // acronym → name
    .replace(/\*\*([^*]*)\*\*/g, '$1')   // **bold**
    .replace(/\*([^*]*)\*/g, '$1')        // *italic*
    .replace(/__([^_]*)__/g, '$1')        // __bold__
    .replace(/_([^_]*)_/g, '$1')          // _italic_
    .replace(/`([^`]*)`/g, '$1')          // `code`
    .replace(/^#{1,6}\s*/gm, '')          // # headings
    .replace(/\*/g, '')                   // stray asterisks
    .replace(/\s{2,}/g, ' ')              // collapse whitespace
    .trim();
}

// Active audio element (so we can cancel mid-speech)
let _activeAudio     = null;
let _playbackChain   = Promise.resolve();  // serial playback queue
let _audioGeneration = 0;                  // increment on clear to discard stale callbacks
let _textStreamTimer = null;               // setInterval handle for character-by-character text reveal

// Eagerly fetch the TTS WAV blob — starts immediately, not when playback is ready
async function _fetchTTSBlob(text) {
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice, speed: 1.0 }),
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch { return null; }
}

// Stream text character by character into `el` from its current value to targetText over `duration` seconds
function _streamTextInto(el, scrollEl, targetText, duration) {
  if (_textStreamTimer !== null) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
  const base  = el.textContent;
  const toAdd = targetText.slice(base.length);
  if (!toAdd.length) return;
  const msPerChar = Math.max(16, (duration * 1000) / toAdd.length);
  let i = 0;
  _textStreamTimer = setInterval(() => {
    i++;
    el.textContent      = base + toAdd.slice(0, i);
    scrollEl.scrollTop  = scrollEl.scrollHeight;
    if (i >= toAdd.length) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
  }, msPerChar);
}

// Play a pre-fetched blob promise; resolves when playback finishes
// onAudioStart (optional): called with the Audio element once metadata is loaded (duration is valid)
async function _playBlob(blobPromise, onAudioStart) {
  setState('speaking');
  const blob = await blobPromise.catch(() => null);
  if (!blob) { setState('idle'); return; }
  return new Promise(resolve => {
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _activeAudio = audio;
    let stopViz = () => {};
    const done  = () => {
      stopViz();
      URL.revokeObjectURL(url);
      _activeAudio = null;
      setState('idle');
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    // Wait for metadata so audio.duration is a valid finite number before starting text stream
    audio.onloadedmetadata = () => {
      try { if (onAudioStart) onAudioStart(audio); } catch(e) {}
      // Wire the output through an AnalyserNode so the waveform and sphere
      // react to the TTS audio being played back.
      stopViz = startOutputViz(audio);
      audio.play().catch(done);
    };
    audio.load();
  });
}

// Enqueue a sentence — synthesis starts NOW in parallel, playback waits its turn
// onStart (optional): called just before this sentence's audio begins playing
function enqueueSpeak(text, onStart) {
  if (ttsMode === 'off') {
    if (onStart) onStart();  // TTS off — reveal text immediately
    return;
  }
  if (ttsMode === 'browser') {
    const gen = _audioGeneration;
    _playbackChain = _playbackChain.then(() => {
      if (_audioGeneration !== gen) return;
      if (onStart) onStart();
      return new Promise(resolve => { _speakBrowser(text); resolve(); });
    });
    return;
  }
  // Kick off synthesis immediately so it overlaps with the current sentence playing
  const blobPromise = _fetchTTSBlob(text);
  const gen = _audioGeneration;
  _playbackChain = _playbackChain.then(() => {
    if (_audioGeneration !== gen) return;   // queue was cleared — discard
    return _playBlob(blobPromise, onStart); // onStart(audio) called once playback begins
  });
}

// Stop all current and queued audio immediately
function clearAudioQueue() {
  _audioGeneration++;                       // invalidates all enqueued callbacks
  _playbackChain = Promise.resolve();
  if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
  if (_textStreamTimer !== null) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
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
  clearAudioQueue();  // stop any in-progress speech before new request
  textInput.value = '';
  appendMessage('user', text);
  await sendToOllama(text);
  fetchSystemStatus();
}

sendBtn.addEventListener('click', handleSend);
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});

// ── Clear conversation ────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  clearAudioQueue();
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatInner.innerHTML = '';
  setState('idle');
});

// ── MediaRecorder → Whisper STT ───────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];

async function startRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return; // guard
  clearAudioQueue();  // interrupt any ongoing speech
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
        clearAudioQueue();  // stop any in-progress speech before new request
        await sendToOllama(transcript);
        fetchSystemStatus();
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

// ── Greeting & model warm-up ─────────────────────────────────────────────────
const GREETING_TEXT =
  `All systems nominal. S.T.A.R.L.I.N.G. online — running ${MODEL} locally on GPU. How can I assist?`;

// Synthesise the greeting to pre-heat Kokoro, then POST the returned WAV to
// /transcribe so the Whisper CUDA session is initialised before the user ever
// presses the mic.
// greetingEl: the <span> holding the placeholder text — updated to the full
// greeting once the warm-up sequence has fully completed.
async function warmupModels(greetingEl) {
  setState('warmup');
  try {
    const blob = await _fetchTTSBlob(_sanitiseForTTS(GREETING_TEXT));
    if (blob) {
      // Warm up Whisper — POST the real speech WAV and discard the transcript.
      // Awaited so fetchSystemStatus() below reflects the post-init GPU state.
      const fd = new FormData();
      fd.append('audio', new File([blob], 'warmup.wav', { type: 'audio/wav' }));
      await fetch(`${BACKEND_BASE}/transcribe/`, { method: 'POST', body: fd }).catch(() => {});
      // Note: we intentionally do NOT play the greeting here. audio.play() is blocked
      // by the browser autoplay policy until the user has made a gesture on the page.
    }
  } catch { /* warm-up failures are non-fatal */ }
  // Both Kokoro and Whisper have now completed their first inference pass — poll
  // system-status so the GPU badges in the footer are populated before the user speaks.
  await fetchSystemStatus();
  // Reveal the full greeting only once everything is ready.
  if (greetingEl) greetingEl.textContent = GREETING_TEXT;
  setState('idle');
}

// ── Init ──────────────────────────────────────────────────────────────────────
initSphere();
statModel.textContent = MODEL;
_applyTtsMode();
loadVoices();
fetchContextLimit();
const { txt: _greetingTxt } = appendMessage('assistant', 'INITIALISING…');
warmupModels(_greetingTxt);  // async — heats Kokoro + Whisper, then reveals greeting
