# S.T.A.R.L.I.N.G. — Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator

A voice-driven, S.T.A.R.L.I.N.G.-style web interface powered by a local LLM running directly via llama.cpp (llama-server). No cloud APIs. No Ollama wrapper. Just your hardware.

---

## Current Issues

| # | Component | Description | Status |
|---|---|---|---|
| 1 | TTS (Kokoro) | Speech playback is lagged ~3–4 s behind text appearing in the UI — full response completes before audio begins | ✅ Resolved — all pipelines migrated to GPU; delay reduced from 2–8 s to ~3–4 s. Sentence-chunked TTS (Phase 7) remains as a further improvement |
| 2 | TTS / STT GPU utilisation | CPU usage spiked during synthesis and transcription; neither pipeline was dispatching to the GPU | ✅ Resolved — Kokoro and Whisper now run on GPU; `onnxruntime-gpu` and CUDA libraries confirmed working |
| 3 | STT (listening mode) | Recording stops too early — silence detection cuts off the user mid-sentence before they have finished speaking | 🔴 Open |
| 4 | TTS (Kokoro) | LLM responses containing markdown/punctuation symbols are vocalised literally — e.g. `*` is spoken as "asterisk", `.` as "dot", `#` as "hash" — making speech sound unnatural and robotic | 🟡 Partial — system prompt instructs the model to respond in plain prose only (no markdown, asterisks, headers, bullet points); a frontend `_sanitiseForTTS()` pass also strips residual symbols. Edge cases may still occur if the model ignores the instruction. |
| 5 | STT / TTS / LLM (cold start) | The first mic press after page load has a noticeably longer end-to-end delay (~6–7 s) compared to subsequent presses (~2–3 s) — models and ONNX sessions are not initialised until the first real request arrives | ✅ Resolved — on page load, the greeting text is synthesised via Kokoro (heats ONNX session) and the resulting WAV is posted to Whisper (heats CUDA session); `fetchSystemStatus()` is awaited before the UI transitions to ONLINE so GPU badges are populated before the user speaks |
| 6 | LLM output (system prompt compliance) | Model occasionally prefixes its response with "Starling: " before the actual output, causing the name to be announced aloud by TTS | 🔴 Open — system prompt already instructs the model to speak in first person as Starling without a speaker prefix, but the instruction is not always followed; likely needs a post-generation strip of leading `Starling:` / `STARLING:` patterns in `_sanitiseForTTS()` or before appending to chat |
| 7 | TTS / audio playback | Clicking the mic button while audio is playing can trigger a glitch where multiple audio clips begin playing simultaneously — two LLM responses race and their TTS output overlaps | 🔴 Open — likely caused by the mic interrupt not fully cancelling the in-flight `_playbackChain` before a new request is enqueued; the active audio element (`_activeAudio`) should be stopped and the chain flushed before starting a new recording session |
| 8 | Presentation mode (voice triggers) | Dossier exit phrases are unreliable — phrases like "close dossier" or "hide dossier" are sometimes missed by STT or fail to match the regex; "return to chat" is the most reliable trigger | 🔴 Open — Whisper transcription variations (e.g. added filler words, punctuation, capitalisation) cause some patterns to fall through; exit regex coverage should be broadened, and/or a fuzzy-match fallback added |
| 9 | Presentation mode (LLM / TTS) | Interrupting the dossier briefing by saying "close dossier" exits the visual presentation mode correctly, but the in-flight LLM stream continues — the full dossier briefing text and audio still complete and appear in chat | 🔴 Open — `exitPresMode()` toggles the CSS class but does not abort the active `fetch` stream or drain the TTS playback queue; the in-flight `sendToOllama` call needs to be cancelled (e.g. via `AbortController`) and `_playbackChain` / `_activeAudio` flushed at the same time as the mode exit |
| 10 | Presentation mode (LLM prompt) | The dossier briefing prompt instructions leaked into the LLM output — e.g. the model echoed "Based on this dossier, deliver a concise spoken briefing..." as part of its response | ✅ Resolved — dossier content is now injected as a `system`-role message so the model treats it as grounding data; the user turn contains only a short clean instruction that the model has no reason to repeat |

**Potential fixes to investigate:**
- **STT early cutoff** — several approaches ranked by effort:
  - **Extend silence timeout**: increase the silence/inactivity threshold in the MediaRecorder stop logic (e.g. from ~500 ms to 1 500–2 000 ms) — lowest effort, try first
  - **Energy-based VAD in the browser**: use the Web Audio API `AnalyserNode` to compute the RMS of the mic signal in real time; only trigger stop when the energy stays below a threshold for a sustained window (avoids cutting off on short inter-word pauses)
  - **Silero VAD (backend)**: run the lightweight Silero VAD model server-side on each incoming audio chunk; it is specifically trained to distinguish speech from silence and is far more accurate than a fixed timeout
  - **`faster-whisper` VAD filter tuning**: `faster-whisper` exposes `vad_filter=True` with tunable `vad_parameters` (min silence duration, speech pad, etc.) — tighten the post-recording filter so short pauses within a sentence are not treated as end-of-speech
  - **Streaming chunked STT**: stream audio to the backend in small chunks via WebSocket; transcribe each chunk with Whisper and only finalise when a real pause is detected rather than relying on the frontend to decide when to stop recording
  - **Push-to-talk only mode**: remove automatic stop entirely — user holds spacebar/button for the full utterance; eliminates all VAD false-positives at the cost of requiring deliberate release
  - **Configurable silence timeout in settings panel**: expose the silence threshold (ms) as a slider in the settings panel so users can tune it for their microphone / speaking style without a code change

- **Symbol vocalisation (Issue #4)** — approaches ranked by effort:
  - **Frontend text sanitiser (lowest effort)**: before passing the LLM response text to the TTS endpoint, run a `sanitiseForSpeech()` function in `app.js` that strips or rewrites common markdown/punctuation symbols — remove `*`, `**`, `_`, `` ` ``, `#`; replace ` — ` with a pause comma; replace `:` at end of a phrase with nothing; etc. This catches the most common cases with zero backend changes
  - **Backend sanitiser in `tts.py`**: apply the same regex cleanup in the `/synthesize` endpoint before passing text to Kokoro — ensures the fix applies regardless of which client calls the API
  - **LLM system-prompt instruction**: add an explicit instruction to the STARLING system prompt telling the model never to use markdown formatting in its responses ("respond in plain prose only, no bullet points, no asterisks, no headers") — reduces the problem at the source but does not eliminate it entirely since the model may ignore it
  - **SSML-aware TTS**: switch to a TTS engine that accepts SSML input (e.g. XTTS-v2, edge-tts) and map markdown structures to SSML pause/emphasis tags — most natural output but highest effort
  - **Sentence-chunked pipeline synergy**: combining with sentence-chunked TTS (Issue #1 follow-up) means the sanitiser runs per-sentence before synthesis, making it easier to test and tune incrementally

**Monitoring**: The `/system-status` endpoint and footer device badges surface GPU vs CPU state for all three pipelines in real time after each exchange — and are now also polled once at startup after the warm-up sequence completes.

---

## Phase 1 — Repo Setup

- [x] Initialize repository: `git init llm-speech-ui`
- [x] Create folder structure (see below)
- [x] Add `.gitignore` (node_modules, __pycache__, .env, models/)
- [x] Add `README.md` with project overview and setup instructions
- [x] Pin Python version with `.python-version` (set to 3.11)
- [x] Add `LICENSE` file (MIT)

```
starling-local/
├── frontend/           # HTML/CSS/JS or React app
│   ├── index.html
│   ├── style.css
│   └── app.js
├── backend/            # FastAPI server (optional glue layer)
│   ├── main.py
│   ├── stt.py              # Speech-to-text (Whisper)
│   ├── tts.py              # Text-to-speech (Kokoro / Piper)
│   ├── llama_server.py     # llama-server (llama.cpp) streaming relay — DEFAULT
│   └── ollama.py           # Ollama API client (kept as fallback)
├── scripts/
│   ├── setup.sh            # One-shot install script
│   └── start_llama_server.bat  # Launch llama-server on Windows (CUDA)
├── .env.example
├── requirements.txt
├── TODO.md
└── README.md
```

---

## Phase 2 — LLM Backend (Ollama)

- [x] Install Ollama: already installed from other local builds
- [x] Pull a base model: several models already downloaded and available
- [x] Verify GPU is being used: GPU-accelerated inference confirmed working
- [x] Test the REST API manually: confirmed working (`llama3.1:8b` responds correctly)
- [x] Document recommended models + VRAM requirements in README
- [x] Add model config to `.env` (model name, API base URL, temperature, system prompt)
- [x] Optionally write a system prompt to give the AI a "S.T.A.R.L.I.N.G." persona

---

## Phase 3 — Speech-to-Text (STT)

### Option A — Browser Web Speech API ~~(easiest)~~
- [x] ~~Implement `webkitSpeechRecognition`~~ — skipped, sends audio to Google (not local)
- [x] ~~Handle `onresult`, `onerror`, and `onend` events~~ — replaced by MediaRecorder approach
- [x] Push-to-talk button with visual feedback (hold to record, release to send)

### Option B — Local Whisper (higher accuracy) ✅ CHOSEN
- [x] Install faster-whisper: installed into `.venv` (v1.2.1)
- [x] Write `backend/stt.py` with a `/transcribe` POST endpoint
- [x] Accept audio blob from frontend (MediaRecorder API)
- [x] Return transcript as JSON
- [x] Model size: `base` (configurable via `WHISPER_MODEL_SIZE` in `.env`)
- [x] Confirm GPU acceleration is working for Whisper (CUDA device count: 1 ✅)

---

## Phase 4 — Text-to-Speech (TTS)

### Option A — Browser SpeechSynthesis (easiest)
- [ ] Implement `SpeechSynthesisUtterance` in `app.js`
- [ ] Let user pick voice from available system voices
- [ ] Tune `rate`, `pitch`, and `volume` for a robotic S.T.A.R.L.I.N.G. feel

### Option B — Kokoro TTS (best local quality) ✅ CHOSEN
- [x] Install Kokoro: `pip install "kokoro-onnx[gpu]"` (v0.5.0, GPU-accelerated)
- [x] Write `backend/tts.py` with `/synthesize` POST endpoint and `/synthesize/voices` GET endpoint
- [x] Return audio as WAV, play via `<Audio>` element in frontend
- [x] 16 curated English voices (US/GB, male/female) selectable from UI dropdown
- [x] TTS mode toggle: Kokoro → Browser → Off (persisted in localStorage)
- [x] Auto-fallback to browser SpeechSynthesis if Kokoro backend unavailable
- [x] Model download script: `python scripts/download_models.py` (~330 MB)
- [ ] Download models: run `python scripts/download_models.py`

### Option C — Piper TTS (fastest, lower quality)
- [ ] Download Piper binary from GitHub releases
- [ ] Download a voice model (e.g. `en_US-ryan-high`)
- [ ] Wrap in a `/synthesize` endpoint in FastAPI

---

## Phase 5 — Frontend UI

- [x] Build base HTML layout with the HUD aesthetic (dark bg, cyan tones)
- [x] Add animated waveform bars (CSS + JS animation, real AudioAnalyser during recording)
- [x] Add arc reactor / ring SVG animation (idle drift + fast spin when thinking, glow when listening)
- [x] Display live streamed LLM response text (token by token with blinking cursor)
- [x] Show STT transcript in real time as user speaks (transcript appended on stop)
- [x] Add status indicators (GPU, model name, STT/TTS engine in footer; status in header)
- [x] Wire mic button: start recording → STT → send to LLM → TTS
- [x] Add text input fallback for when mic is unavailable
- [x] Make UI responsive for different screen sizes (clamp-based sizing)
- [x] Add keyboard shortcut (spacebar push-to-talk)

---

## Phase 6 — FastAPI Backend (glue layer)

- [x] Install FastAPI: `pip install fastapi uvicorn python-dotenv`
- [x] Create `backend/main.py` with route structure
- [x] Add `/chat` endpoint that accepts text and streams LLM response
- [x] Add `/transcribe` endpoint (Whisper STT)
- [x] Add `/synthesize` endpoint (Kokoro TTS) + `/synthesize/voices` GET
- [x] Add `/health` endpoint
- [x] Add `/system-status` endpoint — reports GPU vs CPU for Whisper, Kokoro, and the active LLM backend; polled by the frontend after each exchange and shown as colour-coded badges in the footer
- [x] Enable CORS for local frontend
- [x] Load config from `.env` (model name, API URL, temperature, system prompt, WHISPER_DEVICE, ONNX_PROVIDER)
- [x] Add basic error handling and logging (CUDA fallback in stt.py and tts.py)

---

## Phase 7 — Streaming & Integration

- [x] Implement streaming response from LLM in frontend (`ReadableStream`)
- [x] Render tokens as they arrive (typewriter effect with blinking cursor)
- [x] Maintain conversation history array for multi-turn context
- [x] Pass full conversation history in each LLM request
- [x] Add a “clear conversation” button
- [ ] Start TTS only after full response is received — **done**; sentence-chunked TTS still pending (see Issue #1)

---

## Phase 8 — Polish & UX

- [x] Add loading/thinking animation while LLM is processing (ring spin + state machine)
- [x] Show error messages in UI (model not found, Ollama offline, STT/TTS errors)
- [x] Add auto-scroll to bottom of chat on new messages
- [x] Per-model GPU/CPU device indicators in footer (Whisper / Kokoro / Ollama badges, updated after each exchange)
- [x] Add settings panel: change voice
- [ ] Add settings panel: switch models, adjust temperature
- [ ] Optional: wake word detection ("Hey STARLING") using Web Audio API
- [ ] Optional: sound effects on mic activate / response start

### Design improvements
- [x] Full-width layout — remove side margins/borders so the interface fills the entire browser window
- [x] Borderless chat bubbles — remove visible borders from STARLING and user message containers for a cleaner look
- [x] Chat bubble alignment — user messages aligned to the right, STARLING messages aligned to the left
- [x] Monochrome theme — rework colour palette to blacks, greys, and whites; replace cyan accent tones with light-grey/white highlights

#### Listening state indicator — replace ear emoji
The 👂 emoji clashes with the HUD aesthetic. The indicator should still clearly communicate that STARLING is actively listening. Ideas to explore:
- **Animated ring pulse**: repurpose the existing arc-reactor ring with a slow, steady radial pulse (CSS `scale` keyframe) in a distinct colour (e.g. a dim amber or cool white) to signal the listening state — reuses existing infrastructure with zero new assets
- **Waveform border glow**: animate a soft glow on the waveform bars that is always visible during recording, using a CSS `box-shadow` / `filter: drop-shadow` cycle — ties the "listening" visual directly to the audio input element
- **Scanning line / sweep animation**: a horizontal scan-line that sweeps across the mic button area at a steady cadence, evoking a radar or sonar sweep
- **Dot-matrix text label**: replace the emoji with a monospaced, letter-spaced `LISTENING…` label in a small caps style that blinks or fades in/out — purely typographic, fits the HUD font language
- **Corner bracket blink**: flash the four corner-bracket elements (if present in the layout) in sync with the recording state — subtle, structural, no icons required
- **Mic button state transform**: morph the mic button icon into a minimalist animated waveform SVG (three vertical bars of varying height) only while recording, returning to the static icon when idle
- **Living black sphere** ⭐ ✅ **Implemented**: replaced the flat ring with a Three.js scene featuring a matte black `MeshPhongMaterial` sphere with per-vertex audio-driven displacement, a 4-state machine (idle / listening / thinking / speaking), and 5 orbiting PointLight orbs:
  - *Base appearance*: ✅ matte black sphere with subtle specular highlight
  - *Ambient light drift*: ✅ 5 PointLight orbs orbit on independently tilted planes (varied `tiltX` / `tiltZ`) — smooth, continuous motion using a delta-time accumulator
  - *Idle state*: ✅ orbs glow white at standard speed; sphere surface is smooth
  - *Thinking state*: ✅ state-machine drives CSS class transition; sphere deformation off
  - *Listening state*: ✅ orbs shift to blue (`#88bbff`), orbit speed ramps to 1.6× via smooth lerp; sphere surface deforms in real time driven by `AnalyserNode` frequency data
  - *Speaking state*: ✅ orbs shift to warm yellow (`#ffdd88`), orbit speed ramps to 1.4×; signals TTS playback
  - *Orb glow on sphere*: ✅ PointLight `distance=0, decay=0` for unlimited-range illumination; intensity 8 (idle) / 10 (speaking) / 12 (listening)
  - *Orb count*: ✅ 7 orbs (increased from 5) with distinct speeds, phases, and orbital planes

#### Conversation window — bubbleless layout
Remove background/border styling from message containers so text floats freely. Ideas to differentiate STARLING vs USER without bubbles:
- **Typeface contrast**: STARLING uses a monospaced font (e.g. `JetBrains Mono`, `IBM Plex Mono`) to suggest machine output; USER uses a proportional sans-serif — immediately distinguishable at a glance
- **Colour split**: STARLING text in a light-grey/off-white (`#e0e0e0`); USER text in a dimmer mid-grey (`#888`) — or reverse with USER slightly brighter to feel more "present"
- **Speaker label style**: replace bold `STARLING` / `YOU` headers with small-caps, letter-spaced labels (`S T A R L I N G`, `U S E R`) in a muted tone, sitting above the message text at reduced font size; rename `YOU` → `USER` throughout
- **Left-edge rule for STARLING**: a 2 px vertical rule (`border-left`) in a neutral grey on STARLING messages only — provides visual anchor without a full bubble
- **Indent differentiation**: USER messages indented further right with a larger `padding-left`/`margin-left`, creating natural white-space separation without any background
- **Opacity layering**: STARLING messages at full opacity; USER messages at ~70 % opacity — visually recedes the user text relative to the AI response, emphasising the output
- **Font weight**: STARLING in `font-weight: 300` (light); USER in `font-weight: 400` (regular) — subtle but readable contrast
- [x] Rename speaker label `YOU` → `USER` in frontend (`app.js` / `index.html`)
- [x] Remove bubble background/border styles from message containers in `style.css`
- [x] Implement chosen typographic differentiation scheme (typeface, colour, or weight contrast)

---

## Phase 9 — DevEx & Tooling
- [x] Write `scripts/setup.sh` to automate full install (venv, pip, model download)
- [x] Add `Makefile` with targets: `make install`, `make backend`, `make frontend`, `make llama`, `make test`, `make lint`
- [x] Add hot-reload for frontend (e.g. Vite or live-server) — `make frontend` launches `npx live-server frontend/`
- [x] Add hot-reload for backend (`uvicorn --reload`) — `make backend` runs uvicorn with `--reload` and `--reload-dir`
- [x] Write basic integration test: send text → verify LLM responds end-to-end — `scripts/test_integration.py`
- [x] Document all `.env` variables in `.env.example`

---

## Phase 10 — llama.cpp Migration (Remove Ollama Wrapper) ✅

- [x] Research llama-server as a direct llama.cpp endpoint (OpenAI-compatible SSE)
- [x] Write `backend/llama_server.py` — OpenAI SSE relay re-encoded as Ollama NDJSON so frontend token parsing is unchanged
- [x] Add `LLM_BACKEND` env var to `main.py`; imports `llama_server` or `ollama` router at startup
- [x] Keep `ollama.py` as a fully functional fallback — switch by changing one line in `.env`
- [x] Update `/system-status` to query llama-server `/health` (llama) or Ollama `/api/ps` depending on active backend
- [x] Add `/chat/context-limit` endpoint (queries llama-server `/props` for `n_ctx`)
- [x] Update footer label from `OLLAMA localhost:11434` to `LLM <dynamic-addr>` — address populated from `/system-status` response
- [x] Update `.env` / `.env.example` with `LLAMA_SERVER_URL`, `LLAMA_MODEL`, `LLAMA_TEMPERATURE`, `LLAMA_SYSTEM_PROMPT`
- [x] Add `scripts/start_llama_server.bat` — CUDA launch helper pointing at Ollama blob path
- [x] Add LLM performance metrics bar to UI — single row above TTS controls showing prompt tokens, generation speed, total time, and context window fill (with amber/red warnings at 70%/90%)
- [x] Confirm noticeable speed improvement over Ollama — faster first-token latency, higher t/s observed in metrics bar

---

## Phase 11 — Tool Use (Voice-Activated Features)

Each tool is a self-contained intercept added before the `sendToOllama()` call in
`mediaRecorder.onstop` and `handleSend()`. None modify existing pipeline logic — they all
follow the established pattern: check transcript → return early if matched → resume normal
LLM path if not matched.

**Implementation guides** live in `markdown/` — one file per tool.

### Prerequisite — One-time ES Module Conversion

All tools are written as ES modules (`export function …`). Before implementing any tool, convert
the `app.js` script tag in `index.html` from classic to module:

```html
<!-- Before -->
<script src="app.js?v=4"></script>

<!-- After -->
<script type="module" src="app.js?v=4"></script>
```

This is the only change required to the existing `index.html`. It unlocks `import` statements
at the top of `app.js` for every tool below. Each guide also documents an "inline" fallback
(copy functions directly into `app.js`) for anyone who wants to defer this change.

---

### Risk / Effort Tiers

Tools are ordered from lowest to highest disruption to the existing pipeline:

| # | Tool | Guide | Backend changes | New deps | Risk |
|---|---|---|---|---|---|
| 1 | Time & Date | `TIME.md` | None | None | 🟢 Trivial |
| 2 | Timers | `TIMER.md` | None | None | 🟢 Trivial |
| 3 | Weather | `WEATHER.md` | 1 new router file | `httpx` | 🟢 Low |
| 4 | News Briefing | `NEWS.md` | 1 new router file | `feedparser` | 🟢 Low |
| 5 | Stocks & Crypto | `STOCKS.md` | 1 new router file | `yfinance` | 🟡 Low-Med |
| 6 | Wake Word & Interrupt | `WAKE_WORD.md` | None | None | 🟡 Medium |
| 7 | In-UI Browser Panel | `WEBCALL.md` | None | None | 🟡 Medium |
| 8 | Ideas Tracker | `IDEAS_TRACKER.md` | 1 new router file | None | 🟡 Medium |
| 9 | Journal | `JOURNAL.md` | 1 new router file | None | 🟡 Med-High |
| 10 | Wikipedia RAG | `WIKIPEDIA.md` | 1 new router file | `faiss-cpu` / `chromadb`, embeddings model | 🟠 High |
| 11 | Google Calendar | `CALENDAR.md` | 1 new router file | `google-api-python-client` | 🔴 High |
| 12 | Gmail | `GMAIL.md` | 1 new router file | `google-api-python-client` | 🔴 High |

---

### Tool 1 — Time & Date (`TIME.md`) 🟢

> **Guide:** `markdown/TIME.md`  
> **Pipeline risk:** None — zero backend, zero LLM involvement, sub-200 ms response.

`Date()` in the browser is read at trigger time and formatted directly into natural prose.
No backend file, no new dependency, no mode flag. The spoken response is enqueued to Kokoro
before any network call could even be made.

- [x] Add `detectTimeTrigger(transcript)` function to `app.js` (or import from `time-panel.js`)
- [x] Add time intercept block in `mediaRecorder.onstop` — format `Date()` → `appendMessage` + `enqueueSpeak` → `return`
- [x] Mirror intercept in `handleSend()`
- [x] (Optional) Add clock panel HTML + CSS to `index.html` / `style.css` for a live digital readout
- [x] (Optional) Add date query extension: "what day is it", "what's the date today"

---

### Tool 2 — Timers (`TIMER.md`) 🟢

> **Guide:** `markdown/TIMER.md`  
> **Pipeline risk:** None — zero backend, pure `setInterval`, Web Audio API chime reuses `_getAudioCtx()`.

Timers run entirely in the browser. The existing `_getAudioCtx()` function is reused for the
completion chime — no new AudioContext is created. Multiple named timers are supported.

- [ ] Create `frontend/timer-panel.js` — `detectTimerTrigger()`, `setTimer()`, `cancelTimer()`, `listTimers()`
- [ ] Import in `app.js` and add timer intercept block in `onstop` + `handleSend`
- [ ] Add timer panel HTML to `index.html` (card list with countdown display)
- [ ] Add timer CSS to `style.css`
- [ ] Add `_getAudioCtx()` chime synthesis in `timer-panel.js` (reuses shared AudioContext)
- [ ] Test named timers: "set a 5-minute timer called pasta", "cancel the pasta timer"
- [ ] Test auto-stop: timer chimes and speaks "Timer complete: pasta" via `enqueueSpeak`

---

### Tool 3 — Weather (`WEATHER.md`) 🟢

> **Guide:** `markdown/WEATHER.md`  
> **Pipeline risk:** Low — one new router file, one new frontend module. Uses Open-Meteo (free, no API key, no account).

Follows the exact dossier intercept pattern already proven in the codebase. Backend calls
Open-Meteo's free public API. No authentication required.

- [ ] `pip install httpx` (or confirm already present in `requirements.txt`)
- [ ] Create `backend/weather.py` — `GET /weather` endpoint (lat/lon from `.env`, calls Open-Meteo)
- [ ] Register `weather_router` in `backend/main.py`
- [ ] Add `WEATHER_LAT`, `WEATHER_LON`, `WEATHER_UNITS` to `.env` / `.env.example`
- [ ] Create `frontend/weather-panel.js` — `detectWeatherTrigger()`, `openWeatherPanel()`, render forecast cards
- [ ] Import in `app.js` and add weather intercept block in `onstop` + `handleSend`
- [ ] Add weather panel HTML to `index.html`
- [ ] Add weather panel CSS to `style.css`
- [ ] Test: "What's the weather?" → panel opens + LLM spoken summary of current conditions + 7-day forecast

---

### Tool 4 — News Briefing (`NEWS.md`) 🟢

> **Guide:** `markdown/NEWS.md`  
> **Pipeline risk:** Low — RSS via `feedparser`, free, no API key. Same intercept pattern as weather.

RSS feeds are parsed server-side to avoid CORS. Headline cards are rendered in a panel;
the LLM delivers a spoken briefing from structured context injection.

- [ ] `pip install feedparser`
- [ ] Create `backend/news.py` — `GET /news` endpoint, configurable RSS feed list, 2-minute cache
- [ ] Register `news_router` in `backend/main.py`
- [ ] Add `NEWS_FEEDS` (comma-separated RSS URLs), `NEWS_MAX_ITEMS`, `NEWS_CACHE_SECONDS` to `.env`
- [ ] Create `frontend/news-panel.js` — `detectNewsTrigger()`, `openNewsPanel()`, render headline cards by source
- [ ] Import in `app.js` and add news intercept block in `onstop` + `handleSend`
- [ ] Add news panel HTML to `index.html`
- [ ] Add news panel CSS to `style.css`
- [ ] Test: "News briefing" → panel opens with headlines + LLM spoken summary of top stories

---

### Tool 5 — Stocks & Crypto (`STOCKS.md`) 🟡

> **Guide:** `markdown/STOCKS.md`  
> **Pipeline risk:** Low-Medium — `yfinance` is an unofficial Yahoo Finance scraper (personal use acceptable). Occasionally breaks when Yahoo changes response format; not suitable for production.

Same intercept and panel pattern as weather and news. No API key required.

- [ ] `pip install yfinance`
- [ ] Create `backend/stocks.py` — `GET /stocks` endpoint, configurable ticker list, 5-minute cache
- [ ] Register `stocks_router` in `backend/main.py`
- [ ] Add `STOCKS_TICKERS` (comma-separated), `STOCKS_CACHE_SECONDS` to `.env`
- [ ] Create `frontend/stocks-panel.js` — `detectMarketTrigger()`, `openStocksPanel()`, render ticker grid
- [ ] Import in `app.js` and add stocks intercept block in `onstop` + `handleSend`
- [ ] Add stocks panel HTML + CSS
- [ ] Test: "What's the market doing?" → panel + LLM spoken summary of movers

---

### Tool 6 — Wake Word & Interruptible Conversations (`WAKE_WORD.md`) 🟡

> **Guide:** `markdown/WAKE_WORD.md`  
> **Pipeline risk:** Medium — the always-on Web Speech API listener runs concurrently with `MediaRecorder`. State guards prevent double-recording but require careful ordering. Chrome/Edge only; gracefully disabled in other browsers.

The wake word listener and the interrupt system share the same module. Two new keyboard
shortcuts are also added (Escape = hard stop, existing Spacebar enhanced with interrupt flash).

- [ ] Create `frontend/wake-word.js` — `initWakeWord()`, `startWakeWordListener()`, `stopWakeWordListener()`, `isListening()`
- [ ] Add wake word indicator badge HTML to `index.html` (footer bar)
- [ ] Add WAKE toggle button HTML to `index.html` (bottom bar)
- [ ] Add wake indicator, toggle button, and `interruptFlash` CSS to `style.css`
- [ ] Import in `app.js` — `initWakeWord({ onWakeWord, onInterrupt, onListenerOn, onListenerOff, getState })`
- [ ] Add `_setWakeUI()` helper and `_triggerInterruptFlash()` helper in `app.js`
- [ ] Wire `onWakeWord` callback → `startRecording()` (with state guard: skip if `listening` or `transcribing`)
- [ ] Wire `onInterrupt` callback → `clearAudioQueue()` + 250 ms delay + `startRecording()`
- [ ] Add Escape key listener: hard stop speech/recording → `setState('idle')`
- [ ] Add interrupt flash to mic `mousedown` and spacebar `keydown` when `state === 'speaking'`
- [ ] Persist wake word on/off preference to `localStorage`
- [ ] Test: say "Hey Starling" → mic activates hands-free
- [ ] Test: say "Stop" or "Hey Starling" mid-speech → speech cuts, mic opens
- [ ] Test: press Escape mid-speech → hard stop, returns to idle

---

### Tool 7 — In-UI Browser Panel (`WEBCALL.md`) 🟡

> **Guide:** `markdown/WEBCALL.md`  
> **Pipeline risk:** Medium — frontend-only iframe panel. Many sites block embedding via `X-Frame-Options` / CSP; the guide documents a fallback "open in new tab" path for those. No changes to the recording or TTS pipelines.

Trigger phrase opens a sandboxed iframe panel immediately (zero LLM latency). An optional
backend CORS proxy endpoint can be added later for sites that block direct embedding.

- [ ] Add browser panel HTML to `index.html` (iframe + toolbar + overlay)
- [ ] Add browser panel CSS to `style.css`
- [ ] Create `frontend/browser-panel.js` (or inline in `app.js`) — `detectBrowserTrigger()`, `openBrowserPanel()`, URL bar wiring, back/forward/refresh, fallback "open in new tab"
- [ ] Import / add intercept in `onstop` + `handleSend`
- [ ] Test: "Open YouTube" → panel opens to youtube.com (or falls back to new tab if blocked)
- [ ] Test: "Search Google for weather in New York" → URL bar auto-populated

---

### Tool 8 — Ideas Tracker (`IDEAS_TRACKER.md`) 🟡

> **Guide:** `markdown/IDEAS_TRACKER.md`  
> **Pipeline risk:** Medium — introduces `ideasMode` flag, which gates the next mic press. The flag is checked at position 2 in the intercept chain (immediately after `journalMode`). Must be explicitly cleared in the clear/reset button handler.

Single-press capture: trigger phrase opens panel, next mic press is the idea, LLM auto-generates
a short title, saved to `memory/ideas.json`. Simpler than Journal — no multi-segment
accumulation, no approval step.

- [ ] Create `backend/ideas_routes.py` — `POST /ideas/add`, `GET /ideas`, `GET /ideas/search`, `DELETE /ideas/{id}`, `DELETE /ideas`
- [ ] Register `ideas_router` in `backend/main.py`
- [ ] Add `IDEAS_FILE`, `IDEAS_MAX_RETURN` to `.env`
- [ ] Create `frontend/ideas-panel.js` — `detectIdeaCaptureTrigger()`, `detectIdeaReadTrigger()`, `enterIdeasMode()`, `exitIdeasMode()`, `processIdea()`, `handleIdeaRead()`
- [ ] Import in `app.js`; add `ideasMode` check at position 2 in `onstop` intercept chain
- [ ] Add capture + read trigger intercepts in `onstop` + `handleSend`
- [ ] Add `exitIdeasMode()` to clear button handler
- [ ] Add ideas panel HTML to `index.html` (capture view + list view)
- [ ] Add ideas panel CSS (amber/gold accent)
- [ ] Add `memory/ideas.json` to `.gitignore`
- [ ] Test capture: "Store my idea" → panel appears → speak idea → "Idea stored: [title]"
- [ ] Test read-back: "Show my ideas" → numbered card list + LLM reads titles
- [ ] Test discard: "Discard my last idea" → most recent removed + spoken confirmation

---

### Tool 9 — Voice Journal (`JOURNAL.md`) 🟡

> **Guide:** `markdown/JOURNAL.md`  
> **Pipeline risk:** Medium-High — introduces `journalMode` flag which **must be checked FIRST** in the intercept chain (position 1, before all other tools including `ideasMode`). While in journal mode every mic press is consumed as a journal segment — no other trigger can fire. Failure to place this check at position 1 will cause other tools to misdirect journal segments.

Multi-press dictation mode: user speaks journal content across multiple mic presses, LLM
summarises the full session, user confirms before saving to disk.

- [ ] Create `backend/journal_routes.py` — `POST /journal/save`, `GET /journal/entries`, `GET /journal/search`, `DELETE /journal/entry/{id}`
- [ ] Register `journal_router` in `backend/main.py`
- [ ] Add `JOURNAL_DIR`, `JOURNAL_MAX_ENTRIES` to `.env`
- [ ] Create `frontend/journal-panel.js` — `detectJournalStartTrigger()`, `detectJournalReadTrigger()`, `enterJournalMode()`, `exitJournalMode()`, `addJournalSegment()`, `submitJournal()`, `handleJournalRead()`
- [ ] Import in `app.js`; add `journalMode` check at **position 1** (very top of intercept chain) in `onstop`
- [ ] Add journal start + read trigger intercepts in `onstop` + `handleSend`
- [ ] Add `exitJournalMode()` to clear button handler
- [ ] Add journal panel HTML to `index.html` (dictation view + review/confirm view + entries list)
- [ ] Add journal panel CSS (violet accent)
- [ ] Add `memory/journal/` to `.gitignore`
- [ ] Test dictation: "Start a journal entry" → multiple mic presses → "Done" → LLM summary shown → confirm to save
- [ ] Test read-back: "Read my journal" → entry list + LLM reads most recent
- [ ] Test search: "Search journal for meeting" → filtered entries

---

### Tool 10 — Wikipedia RAG (`WIKIPEDIA.md`) 🟠

> **Guide:** `markdown/WIKIPEDIA.md`  
> **Pipeline risk:** High — new Python dependencies (`faiss-cpu` or `chromadb`, `sentence-transformers` or `nomic-embed-text`), a one-time corpus ingestion step, and in-memory session management on the backend. The trigger phrase `"wikipedia search"` is distinct from `"dossier"` and does not affect the existing RAG path. All existing files remain untouched.

Implement Phase 1 first (Simple English Wikipedia, ~250 MB, ~200,000 articles). Phases 2–3
(full English Wikipedia, live API, custom embeddings) are optional expansions.

- [ ] `pip install faiss-cpu sentence-transformers` (or `chromadb` as vector store alternative)
- [ ] Download Simple English Wikipedia dump (see guide for direct URL)
- [ ] Create `backend/wikipedia_rag.py` — ingestion pipeline, FAISS index, `WikipediaSession` class
- [ ] Create `backend/wiki_routes.py` — `POST /wiki/search`, `POST /wiki/chat`, `DELETE /wiki/session`
- [ ] Register `wiki_router` in `backend/main.py`
- [ ] Add `WIKI_INDEX_PATH`, `WIKI_EMBED_MODEL`, `WIKI_TOP_K` to `.env`
- [ ] Create `frontend/wiki-panel.js` — `detectWikiTrigger()`, `openWikiPanel()`, session Q&A flow
- [ ] Import in `app.js` and add wiki intercept block in `onstop` + `handleSend`
- [ ] Add wiki panel HTML + CSS
- [ ] Run one-time ingestion: `python backend/wikipedia_rag.py --ingest` (allow 30–60 min)
- [ ] Test: "Wikipedia search" → Starling asks what to look up → Q&A grounded in article → no hallucination

---

### Tool 11 — Google Calendar (`CALENDAR.md`) 🔴

> **Guide:** `markdown/CALENDAR.md`  
> **Pipeline risk:** High — requires a Google Cloud project, OAuth2 Desktop app credentials, and a one-time browser auth flow. The token auto-refreshes after initial setup. Backend file named `calendar_routes.py` (NOT `calendar.py`) to avoid Python stdlib collision.

- [ ] Create Google Cloud project and enable Google Calendar API (see guide Step A1)
- [ ] Download OAuth credentials JSON → `credentials/google_calendar_credentials.json`
- [ ] Add `credentials/` to `.gitignore`
- [ ] `pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib`
- [ ] Run one-time auth: `python scripts/auth_google_calendar.py` (creates `google_token.json`)
- [ ] Create `backend/calendar_routes.py` — `GET /calendar/today`, `GET /calendar/week`
- [ ] Register `calendar_router` in `backend/main.py`
- [ ] Add `CALENDAR_BACKEND`, `GOOGLE_CREDENTIALS_FILE`, `GOOGLE_TOKEN_FILE`, `CALENDAR_TIMEZONE` to `.env`
- [ ] Create `frontend/calendar-panel.js` — `detectCalendarTrigger()`, event list, week view
- [ ] Import in `app.js` and add calendar intercept block in `onstop` + `handleSend`
- [ ] Add calendar panel HTML + CSS
- [ ] Test: "What's on my schedule today?" → event list + LLM spoken daily briefing

---

### Tool 12 — Gmail (`GMAIL.md`) 🔴

> **Guide:** `markdown/GMAIL.md`  
> **Pipeline risk:** High — same OAuth2 setup complexity as Calendar. Requires `gmail.readonly` + `gmail.modify` scopes. If Calendar OAuth is already configured, the same Google Cloud project is reused — add the Gmail scopes and re-run auth. Body truncated at 6,000 chars before LLM injection to avoid context overflow.

- [ ] Enable Gmail API in existing Google Cloud project (or create one if Calendar was skipped)
- [ ] Add `gmail.readonly` and `gmail.modify` scopes to OAuth consent screen
- [ ] Download OAuth credentials → `credentials/google_gmail_credentials.json` (can reuse calendar creds file)
- [ ] Run one-time auth: `python scripts/auth_gmail.py` (creates `google_gmail_token.json`)
- [ ] Create `backend/gmail_routes.py` — `GET /gmail/unread`, `GET /gmail/message/{id}`, `POST /gmail/trash/{id}`
- [ ] Register `gmail_router` in `backend/main.py`
- [ ] Add `GMAIL_CREDENTIALS_FILE`, `GMAIL_TOKEN_FILE`, `GMAIL_MAX_UNREAD`, `GMAIL_CACHE_SECONDS` to `.env`
- [ ] Create `frontend/gmail-panel.js` — `detectGmailTrigger()`, inbox list, message view, summarise, trash
- [ ] Call `wireGmailActionButtons()` once on page init (wires SUMMARISE + DELETE buttons)
- [ ] Import in `app.js` and add gmail intercept block in `onstop` + `handleSend`
- [ ] Add `gmailPanel.classList.add('hidden')` to clear button handler
- [ ] Add Gmail panel HTML + CSS (inbox view + message view)
- [ ] Test: "View my emails" → inbox + LLM spoken count and sender briefing
- [ ] Test: "Summarize that email" → 3–5 sentence LLM summary of open message
- [ ] Test: "Delete that email" → moves to Trash + spoken confirmation

---

### Final Intercept Order (all tools implemented)

Once all tools are active, the intercept chain in `mediaRecorder.onstop` and `handleSend`
must follow this exact order to avoid mode flag collisions:

```
1.  journalMode active check      ← MUST be first (gates all mic presses in journal mode)
2.  ideasMode active check        ← MUST be second (gates next mic press in ideas mode)
3.  _matchesExitPhrase            ← dossier exit
4.  _parseTrigger                 ← dossier open
5.  detectJournalStartTrigger     ← enter journal dictation mode
6.  detectJournalReadTrigger      ← journal read / search / delete
7.  detectIdeaCaptureTrigger      ← enter ideas capture mode
8.  detectIdeaReadTrigger         ← ideas list / search / discard / clear
9.  detectTimerTrigger            ← timer set / cancel / status
10. detectTimeTrigger             ← time / date query
11. detectWeatherTrigger          ← weather forecast
12. detectCalendarTrigger         ← calendar schedule
13. detectNewsTrigger             ← news briefing
14. detectMarketTrigger           ← stocks / crypto
15. detectGmailTrigger            ← Gmail inbox / open / summarise / trash
16. detectWikiTrigger             ← Wikipedia RAG search
17. detectBrowserTrigger          ← in-UI browser panel
18. appendMessage + sendToOllama  ← normal LLM path (catch-all)
```

---

## Stretch Goals

- [ ] Add tool use / function calling (weather, web search, calendar)
- [X] Visualize GPU/CPU load live in the HUD
- [ ] Add multiple AI "modes" (assistant, coder, analyst) with different system prompts
- [ ] Package as an Electron desktop app for no-browser-needed launch
- [ ] Add local RAG (retrieval-augmented generation) with a document folder
- [ ] Support multiple simultaneous models / model switching on the fly

---

### Stretch Goal — GraphRAG Knowledge Graph Memory [HOLD DUE TO SPEED CONCERNS]

Replace flat vector RAG with [Microsoft GraphRAG](https://github.com/microsoft/graphrag): a structured, hierarchical RAG system that builds a knowledge graph from your documents. Unlike baseline RAG (top-k vector similarity), GraphRAG extracts entities and relationships, clusters them into communities using the Leiden algorithm, and generates multi-level summaries — enabling the AI to answer holistic "what is this corpus about?" questions as well as specific entity-level lookups.

#### Step 1 — Install & configure GraphRAG
- [ ] `pip install graphrag` into `.venv`
- [ ] Create a `memory/` folder as the GraphRAG data root (add `memory/output/` to `.gitignore`)
- [ ] Run `graphrag init --root memory/` to scaffold `settings.yaml` and prompt templates
- [ ] Configure `settings.yaml` to use Ollama as the LLM via the LiteLLM `openai`-compatible proxy:
  - Set `api_base: http://localhost:11434/v1` and `model: ollama/<model_name>` in both `completion_models` and `embedding_models`
  - Use `nomic-embed-text` (already pulled) for embeddings; use `llama3.1:8b` or `qwen2.5:7b` for completion
  - Set `indexing_method: fast` initially to avoid heavy LLM usage during graph extraction — switch to `standard` (LLM-extracted entities) once it's working
- [ ] Run `graphrag prompt-tune --root memory/` to auto-tune extraction prompts for the local model

#### Step 2 — Build the document corpus
- [ ] Create `memory/input/` as the watched document folder
- [ ] Write a `scripts/export_conversations.py` script that appends each completed conversation turn to a dated `.txt` file in `memory/input/` (one file per session)
- [ ] Decide on additional document sources to ingest: notes, project docs, README, etc.

#### Step 3 — Index the corpus into a knowledge graph
- [ ] Run the indexing pipeline: `graphrag index --root memory/`
  - This extracts entities, relationships, and claims from all `.txt`/`.md` files in `memory/input/`
  - Performs Leiden community detection to group related entities
  - Generates hierarchical community summaries (bottom-up, multiple granularity levels)
  - Outputs Parquet tables to `memory/output/` and embeddings to a local vector store
- [ ] Add a `POST /memory/index` endpoint in `backend/main.py` that triggers re-indexing as a background task (using `asyncio.create_subprocess_exec` calling the graphrag CLI)

#### Step 4 — Wire query into the chat pipeline
- [ ] Add a `POST /memory/query` endpoint in `backend/main.py` that wraps the GraphRAG Python query API:
  - **Local search**: for entity-specific questions — fans out from named entities to neighbors and associated claims
  - **Global search**: for holistic/thematic questions — uses community summaries to synthesise a corpus-wide answer
  - Accept a `mode: "local" | "global" | "drift"` parameter; default to `local`
- [ ] In `backend/ollama.py`, before streaming the Ollama response, call `/memory/query` with the user's message
- [ ] Prepend the returned graph context as a `system`-role message block in the conversation history sent to Ollama (keep it under ~2 000 tokens to stay within context window)

#### Step 5 — Auto-index new conversations
- [ ] After each complete assistant turn, append the exchange (user + assistant) to the current session file in `memory/input/`
- [ ] Trigger an incremental re-index in the background (debounced — at most once every N minutes, configurable via `.env`)
- [ ] Add a `GET /memory/status` endpoint returning the last index timestamp and entity/community counts from the Parquet output

#### Step 6 — Surface memory in the HUD
- [ ] Add a `MEMORY` stat chip to the header stats row (shows entity count or `OFF` when no index exists)
- [ ] Show a subtle "memory active" indicator on the ring when graph context was injected into a response
- [ ] Add a `MEMORY` button to the controls row that opens a simple panel listing: last indexed time, document count, top entities, and a manual "Re-index now" trigger
- [ ] Display the active search mode (`LOCAL` / `GLOBAL`) in the footer alongside the TTS/STT labels

#### Phase 9 maintenance notes (what needs updating when GraphRAG is implemented)

- **`setup.sh`** — effectively set-and-forget; no changes needed unless a second model download step is added beyond Kokoro (e.g. downloading a GraphRAG embedding model)
- **`Makefile`** — stable as-is; if a separate memory/indexing server needs launching, just add a new `make memory` target rather than rewriting existing ones
- **`.env.example`** — add a documented entry for every new env var introduced (e.g. `GRAPHRAG_ROOT`, `GRAPHRAG_LLM_MODEL`); one line + comment per variable, 2 minutes each
- **`scripts/test_integration.py`** — this is the one that needs active maintenance as the API grows: every new endpoint (`/memory/query`, `/memory/index`, `/memory/status`) needs a corresponding `async def test_xxx` function (~15–20 lines each, following the same pattern already there); existing tests only break if their endpoint's response shape changes (e.g. new required keys in `/system-status`)

---

### Stretch Goal — Electron Desktop App

Package S.T.A.R.L.I.N.G. as a standalone desktop application — no browser, no terminal, no manual server launch. The user double-clicks an icon and the full stack (FastAPI backend + llama-server + frontend) starts automatically inside a single native window.

**Architecture overview:**
- **Electron main process** (`electron/main.js`) acts as the process supervisor: spawns the Python backend binary and optionally llama-server, polls until both are ready, then opens a `BrowserWindow` pointed at `http://localhost:8000`.
- **Python backend** is frozen with PyInstaller into a single `backend.exe` / `backend` binary bundled inside the Electron app's `resources/` folder.
- **llama-server** binary is also bundled in `resources/` and auto-launched with the same CUDA flags currently in `start_llama_server.bat`.
- **Frontend** continues to be served by FastAPI (no change to `frontend/` code or asset paths).

#### Step 1 — Add Electron scaffold

- [ ] Create `electron/` folder at repo root with three files: `main.js`, `preload.js`, `package.json`
- [ ] Add a root-level `package.json` (separate from any frontend tooling) with Electron as a dev dependency:
  ```json
  {
    "name": "starling-local",
    "version": "1.0.0",
    "main": "electron/main.js",
    "devDependencies": {
      "electron": "^30.0.0",
      "electron-builder": "^24.0.0"
    }
  }
  ```
- [ ] Run `npm install` to pull Electron into `node_modules/` — add `node_modules/` to `.gitignore` if not already present
- [ ] Add a `make electron-dev` Makefile target: `npx electron .` — launches the app in dev mode (backend and llama-server still started manually, window loads `http://localhost:8000`)

#### Step 2 — Electron main process: window + lifecycle

- [ ] Write `electron/main.js` with the following responsibilities:
  - `app.whenReady()` → call `spawnBackend()`, then `spawnLlamaServer()`, then `pollUntilReady()`, then `createWindow()`
  - `createWindow()`: create a frameless (or default) `BrowserWindow` (1 280 × 800, min 900 × 600); load `http://localhost:8000`; show only after `did-finish-load` fires to avoid a white flash
  - `app.on('before-quit')` and `app.on('window-all-closed')`: kill both child processes gracefully (`SIGTERM` → wait 2 s → `SIGKILL`)
- [ ] Add a system tray icon: right-click menu with "Open", "Restart backend", "Quit"
  - Tray icon asset: create a 16 × 16 and 32 × 32 PNG in `assets/images/tray-icon.png`
- [ ] Wire `app.on('activate')` (macOS dock click) to re-show the window if it exists but is hidden

#### Step 3 — Freeze the Python backend with PyInstaller

- [ ] `pip install pyinstaller` into `.venv`
- [ ] Create `scripts/build_backend.spec` — a PyInstaller spec file that:
  - Sets `pathex` to `backend/`
  - Includes all data files: `backend/` Python modules, `models/` ONNX files (as `datas`), `frontend/` static assets (so FastAPI's `StaticFiles` mount works from the frozen binary)
  - Adds hidden imports for `faster_whisper`, `kokoro_onnx`, `onnxruntime`, `uvicorn`, `fastapi`, `anyio`
  - Marks CUDA `.dll`/`.so` files as binaries so they are copied into the bundle
  - `onefile=False` (directory bundle) — `onefile` is slower to start and harder to debug; use a folder bundle named `backend_dist/`
- [ ] Add a `make build-backend` Makefile target: `pyinstaller scripts/build_backend.spec --distpath dist/backend`
- [ ] Test the frozen binary standalone: `dist/backend/main/main.exe` should serve on port 8000 with no Python install present
- [ ] Handle the `.env` file: copy it next to the binary at build time; Electron main process also writes a resolved `.env` before spawning the binary (so paths like `LLAMA_SERVER_URL` can be made absolute to the bundle root)

#### Step 4 — Bundle and auto-launch llama-server

- [ ] Download the official llama.cpp release binary for the target platform (CUDA build for Windows: `llama-<version>-win-cuda-cu12.x-x64.zip`) and place `llama-server.exe` in `resources/llama/`
- [ ] Copy the GGUF model file into `resources/llama/models/` at build time (or provide a first-run download step — see Step 7)
- [ ] Write `spawnLlamaServer(resourcesPath)` in `electron/main.js`:
  ```js
  const bin  = path.join(resourcesPath, 'llama', 'llama-server.exe');
  const model = path.join(resourcesPath, 'llama', 'models', 'llama3.2-3b-q4_k_m.gguf');
  llamaProc = spawn(bin, ['-m', model, '--port', '8080', '-ngl', '29', '--ctx-size', '4096'], {
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' }
  });
  ```
- [ ] `spawnLlamaServer` skips launch if port 8080 is already in use (user may have llama-server running externally) — check with a quick `net.createServer` probe before spawning
- [ ] Stream `llamaProc.stderr` to a log file at `app.getPath('logs')/llama-server.log` for debugging

#### Step 5 — Readiness polling

- [ ] Write `pollUntilReady(urls, timeoutMs)` in `electron/main.js`:
  - Accepts an array of health-check URLs (e.g. `['http://localhost:8000/health', 'http://localhost:8080/health']`)
  - Polls every 500 ms with `net.request` (Electron's native HTTP, works before the renderer is open)
  - Resolves when all URLs return 200; rejects (shows error dialog) after `timeoutMs` (default 30 000 ms)
- [ ] Display a native loading splash while polling: a small secondary `BrowserWindow` rendering `frontend/splash.html` (static HTML, no server needed) — close it once `pollUntilReady` resolves
- [ ] On timeout: show `dialog.showErrorBox('Startup failed', '...')` with log file path, then `app.quit()`

#### Step 6 — preload.js and IPC

- [ ] Write `electron/preload.js` with `contextBridge.exposeInMainWorld('starling', {...})` exposing:
  - `getAppVersion()` → `app.getVersion()` via IPC
  - `openLogsFolder()` → `shell.openPath(app.getPath('logs'))` — lets the user inspect llama/backend logs from the UI settings panel
  - `openDocumentFolder(path)` → `shell.openPath(path)` — for the future RAG document folder
- [ ] Wire the "Open Logs" button (add to settings panel in a future pass) to call `window.starling.openLogsFolder()`
- [ ] Keep `nodeIntegration: false` and `contextIsolation: true` in `BrowserWindow` webPreferences — never expose Node APIs directly to the renderer

#### Step 7 — First-run model download (optional, if not bundling model)

- [ ] If the GGUF model is too large to bundle in the installer (>2 GB), implement a first-run download flow:
  - On first launch, check if model file exists in `app.getPath('userData')/models/`
  - If not, show a modal (`BrowserWindow` or `dialog`) explaining the download (~2 GB), then stream it with `net.request` to `userData/models/` showing progress
  - Write download progress back to the renderer via `ipcMain` → `webContents.send('download-progress', pct)`
  - Once complete, proceed with normal startup; model path is written into the resolved `.env`

#### Step 8 — Package with electron-builder

- [ ] Add `build` section to root `package.json`:
  ```json
  "build": {
    "appId": "com.starling.local",
    "productName": "STARLING",
    "directories": { "output": "dist/electron" },
    "extraResources": [
      { "from": "dist/backend", "to": "backend" },
      { "from": "resources/llama", "to": "llama" }
    ],
    "win": { "target": "nsis", "icon": "assets/images/icon.ico" },
    "mac": { "target": "dmg", "icon": "assets/images/icon.icns" },
    "linux": { "target": "AppImage", "icon": "assets/images/icon.png" }
  }
  ```
- [ ] Add a `make dist` Makefile target that runs the full chain: `make build-backend` → `npx electron-builder --win` (adjust platform flag per OS)
- [ ] Test the NSIS installer on a clean Windows machine with no Python, Node, or CUDA toolkit installed — only the NVIDIA driver should be required
- [ ] Add `electron-updater` (`npm install electron-updater`) and a `latest.yml` publish target pointing at a GitHub Releases feed — enables auto-update prompts on launch

#### Phase 9 maintenance notes (Electron)

- **`setup.sh`** — add `npm install` step at the end (skip if `node_modules/` already exists); add a check for Node ≥ 18
- **`Makefile`** — add `electron-dev`, `build-backend`, and `dist` targets; document in `make help`
- **`.env.example`** — add `ELECTRON_DEV=true` flag (when set, Electron skips spawning backend/llama-server and assumes they are already running — useful during development)
- **`scripts/test_integration.py`** — no changes needed; integration tests continue to run against the standalone backend and are still valid for the frozen binary

---

## Closed Topics

Approaches considered for resolved issues — retained for reference in case issues resurface or interact with future work.

### Issue #1 — TTS lag (✅ Resolved)
**Resolution**: all pipelines migrated to GPU; delay reduced from 2–8 s to ~3–4 s.

**Approaches considered:**
- **Sentence-chunked TTS** *(chosen path for further improvement)*: split the streamed response on `.`, `?`, `!` boundaries and synthesise + play each sentence as it completes rather than waiting for the full response (see Phase 7)

### Issue #2 — TTS / STT GPU utilisation (✅ Resolved)
**Resolution**: Kokoro and Whisper now run on GPU; `onnxruntime-gpu` and CUDA libraries confirmed working.

### Issue #5 — Cold-start delay (✅ Resolved)
**Resolution**: on page load, `warmupModels()` synthesises the greeting via Kokoro (heats the ONNX/CUDA session), posts the resulting WAV to `/transcribe` (heats the Whisper CUDA session), then awaits `fetchSystemStatus()` before transitioning to ONLINE. The UI shows `INITIALISING…` and the sphere enters the `WARMING UP` state until the full sequence completes.

**Approaches considered (ranked by effort at time of investigation):**
- **Warm-up ping on page load** *(implemented — adapted)*: synthesise the greeting text via `/synthesize` and post the result to `/transcribe`; both sessions are live before the user speaks
- **Silent audio warm-up for Whisper**: generate a short (0.5 s) silent WAV blob using `OfflineAudioContext` and POST to `/transcribe` — superseded by using the real greeting WAV
- **Backend `/warmup` endpoint**: a dedicated `GET /warmup` route in `main.py` running dummy inference through all three pipelines — not needed given the frontend approach
- **Lazy import → eager import in backend**: move model loading to module-level so Uvicorn startup triggers initialisation — deferred; current approach is sufficient
- **FastAPI `startup` event for all models**: `@app.on_event("startup")` handler calling warm-up logic for all three pipelines — deferred; covered by frontend warm-up
- **Show `WARMING UP` state in HUD** *(implemented)*: sphere enters thinking animation and status shows `INIT...`; greeting text held as `INITIALISING…` until sequence completes

---

## Stack Summary

| Layer | Tool | Notes |
|---|---|---|
| LLM runtime | llama-server (llama.cpp) | Direct GPU inference — default; Ollama kept as fallback |
| LLM model | Llama 3.2 3B / Llama 3.1 8B / Mistral 7B | GGUF blobs from Ollama cache |
| STT | faster-whisper | CUDA-accelerated local transcription |
| TTS | Kokoro TTS (kokoro-onnx) | GPU-accelerated via CUDA or DirectML |
| Backend | FastAPI + uvicorn | Glue layer for STT, TTS, LLM relay |
| Frontend | Vanilla HTML/CSS/JS + Three.js | Served by FastAPI at port 8000 |