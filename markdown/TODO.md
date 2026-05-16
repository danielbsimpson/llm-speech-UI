# S.T.A.R.L.I.N.G. — Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator

A voice-driven, S.T.A.R.L.I.N.G.-style web interface powered by a local LLM running directly via llama.cpp (llama-server). No cloud APIs. No Ollama wrapper. Just your hardware.

---

## Current Issues

| # | Component | Description | Status |
|---|---|---|---|
| 1 | TTS (Kokoro) | Speech playback is lagged ~3–4 s behind text appearing in the UI — full response completes before audio begins | ✅ Resolved — all pipelines migrated to GPU; delay reduced from 2–8 s to ~3–4 s. Sentence-chunked TTS (Phase 7) remains as a further improvement |
| 2 | TTS / STT GPU utilisation | CPU usage spiked during synthesis and transcription; neither pipeline was dispatching to the GPU | ✅ Resolved — Kokoro and Whisper now run on GPU; `onnxruntime-gpu` and CUDA libraries confirmed working |
| 3 | STT (listening mode) | Recording stops too early — silence detection cuts off the user mid-sentence before they have finished speaking | ✅ Resolved — (1) `mouseleave` PTT stop replaced with document-level `mouseup` so cursor drift mid-speech no longer stops recording; (2) Whisper backend VAD `min_silence_duration_ms` raised from 500 ms to 1 500 ms so short inter-word pauses are not treated as end-of-speech |
| 4 | TTS (Kokoro) | LLM responses containing markdown/punctuation symbols are vocalised literally — e.g. `*` is spoken as "asterisk", `.` as "dot", `#` as "hash" — making speech sound unnatural and robotic | 🟡 Partial — system prompt instructs the model to respond in plain prose only (no markdown, asterisks, headers, bullet points); a frontend `_sanitiseForTTS()` pass also strips residual symbols. Edge cases may still occur if the model ignores the instruction. |
| 5 | STT / TTS / LLM (cold start) | The first mic press after page load has a noticeably longer end-to-end delay (~6–7 s) compared to subsequent presses (~2–3 s) — models and ONNX sessions are not initialised until the first real request arrives | ✅ Resolved — on page load, the greeting text is synthesised via Kokoro (heats ONNX session) and the resulting WAV is posted to Whisper (heats CUDA session); `fetchSystemStatus()` is awaited before the UI transitions to ONLINE so GPU badges are populated before the user speaks |
| 6 | LLM output (system prompt compliance) | Model occasionally prefixes its response with "Starling: " before the actual output, causing the name to be announced aloud by TTS | ✅ Resolved — `_sanitiseForTTS()` now strips any leading `Starling:` / `STARLING:` / `S.T.A.R.L.I.N.G.:` pattern before text reaches Kokoro |
| 7 | TTS / audio playback | Clicking the mic button while audio is playing can trigger a glitch where multiple audio clips begin playing simultaneously — two LLM responses race and their TTS output overlaps | ✅ Resolved — `sendToOllama` now creates an `AbortController` per request assigned to `_currentAbortCtrl`; `clearAudioQueue()` aborts it on every new mic press or text send, cancelling the in-flight fetch before any new request starts |
| 8 | Presentation mode (voice triggers) | Dossier exit phrases are unreliable — phrases like "close dossier" or "hide dossier" are sometimes missed by STT or fail to match the regex; "return to chat" is the most reliable trigger | ✅ Resolved — `_matchesExitPhrase()` regex coverage broadened: added `closed`, `exiting`, `dismiss`, `end briefing/presentation`, `stop briefing`, reverse-order `dossier … close/exit`, `never mind`, `nevermind`, `cancel that`; `back to` now also matches `back to main` |
| 9 | Presentation mode (LLM / TTS) | Interrupting the dossier briefing by saying "close dossier" exits the visual presentation mode correctly, but the in-flight LLM stream continues — the full dossier briefing text and audio still complete and appear in chat | ✅ Resolved — same `AbortController` fix as Issue #7; `clearAudioQueue()` is always called before `_routeInput()` on the voice path, aborting the previous `sendToOllama` fetch the moment the user issues a new command |
| 10 | Presentation mode (LLM prompt) | The dossier briefing prompt instructions leaked into the LLM output — e.g. the model echoed "Based on this dossier, deliver a concise spoken briefing..." as part of its response | ✅ Resolved — dossier content is now injected as a `system`-role message so the model treats it as grounding data; the user turn contains only a short clean instruction that the model has no reason to repeat |
| 11 | Tool panels (overlap) | When one tool panel is already visible (e.g. the timer panel showing a completed timer) and the user triggers a second tool (e.g. "what time is it"), the new panel renders on top of the existing one — both are visible simultaneously until the next user interaction | ✅ Resolved — `.chat-panel` converted to a flex column (`display: flex; flex-direction: column`); `.clock-panel` changed from `position: absolute` to `position: relative; flex-shrink: 0` so it occupies normal flow space; `.chat-inner` switched to `flex: 1; min-height: 0`. All visible tool panels now stack vertically rather than overlapping |
| 12 | Timer (label parsing) | Named timers are not labelled correctly — "set a timer for 5 minutes called pasta" produces a timer with no label (or the duration itself as the label), and the completion announcement doubles the duration: "Your 5 minutes 5 minutes timer is done." The "called / named" keyword is not handled at all | ✅ Resolved — `detectTimerTrigger` now checks for a `called/named` suffix first (highest priority); the fallback label regex now rejects candidates that start with a digit or consist entirely of duration unit words (`minute`, `second`, `hour`, plurals, numeric strings) |
| 13 | Weather panel (layout) | On wide-screen monitors the weather panel takes up too much vertical space — the current conditions block is oversized and the 5-day forecast strip is pushed down to a small portion of the panel, making the forecast hard to read at a glance | ✅ Resolved — `@media (min-width: 1400px)` converts the weather panel to a CSS grid with current conditions on the left and the 7-day forecast on the right; both sections share the horizontal space equally |
| 14 | News briefing (synthesis latency) | End-to-end response time for the news briefing ballooned to ~35 s after the cross-source story synthesis update — the LLM synthesis call is a synchronous blocking step between RSS fetch and panel render, so nothing is visible to the user until the full synthesis completes | � In Progress — Approaches A+B implemented (parallel fetch + background synthesis + frontend polling) |

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

**Issue #14 — News synthesis latency (~35 s) — potential fixes ranked by effort / impact**

The bottleneck is a single blocking LLM call that processes all raw headlines before anything is shown. Approaches below are ranked from least to most invasive:

| # | Approach | Effort | Expected gain |
|---|---|---|---|
| A | **Raw headlines first, synthesise in background** | 🟢 Low | Panel opens immediately with raw cards; synthesis result patches in silently once ready — user sees content within ~2 s, synthesis arrives ~30 s later without any perceived wait |
| B | **Progressive panel render — RSS feeds stream in one-by-one** | 🟢 Low | Open the panel immediately with a spinner; as each RSS feed resolves, append its raw cards to the list in real time — panel feels live even before synthesis starts |
| C | **Streaming synthesis via SSE** | 🟡 Medium | LLM synthesis endpoint returns each clustered story as a Server-Sent Event; frontend appends a new story card for each SSE line — user sees stories appear one-by-one over ~30 s instead of nothing then everything |
| D | **Per-story synthesis (incremental prompts)** | 🟡 Medium | Instead of one giant prompt for all headlines, fire N small LLM calls (one per story cluster detected by a lightweight local dedup heuristic); results stream into the panel as each mini-prompt resolves |
| E | **Reduce synthesis input size** | 🟢 Low | Lower `NEWS_SYNTHESIS_MAX_HEADLINES` from 40 → 15–20; the model spends less time reading context; sacrifice completeness for speed |
| F | **Background warm cache** | 🟢 Low | After any successful synthesis, schedule a background re-fetch/re-synthesise at `NEWS_CACHE_SECONDS / 2`; subsequent opens hit a warm synthesised cache and respond in < 1 s |
| G | **Lightweight client-side dedup before LLM** | 🟡 Medium | Before calling the LLM, run a Jaccard / edit-distance deduplifier in Python that pre-groups obvious duplicates by title similarity; send only the representative titles to the LLM — smaller input, faster call |
| H | **Skip synthesis for single-source categories** | 🟢 Trivial | If a category only has one RSS feed configured, skip the LLM synthesis step entirely (nothing to deduplicate) and render raw cards immediately |
| I | **Async synthesis with placeholder cards** | 🟢 Low | Render a skeleton card for each raw headline immediately; patch each card's content with the synthesised version as the LLM result arrives — avoids any perceived blank panel |

**Recommended short-term fix — Approach A (raw-first, background synthesis):**

1. `GET /news` returns immediately with raw headlines + `synthesised: null`.
2. A second `GET /news/synthesise?category=<tag>` endpoint triggers the LLM call asynchronously and caches the result.
3. Frontend polls `GET /news/synthesise/status?category=<tag>` (or opens a short SSE connection) and patches the story cards in once the result lands.
4. The LLM spoken briefing is still delivered from the `llm_context` (raw headlines), which is already available — TTS is unaffected.

**Recommended medium-term fix — Approach C (streaming synthesis):**

Backend streams each synthesised story object as a JSON line over SSE. Frontend appends a rendered card for each line. User sees the first story within ~2–3 s and subsequent stories trickle in. No polling required, no skeleton cards needed.

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
| 5 | Stocks & Crypto | `STOCKS.md` | 1 new router file | `yfinance`, `tzdata` | ✅ Done |
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

- [x] Create `frontend/timer-panel.js` — `detectTimerTrigger()`, `setTimer()`, `cancelTimer()`, `listTimers()`
- [x] Import in `app.js` and add timer intercept block in `onstop` + `handleSend`
- [x] Add timer panel HTML to `index.html` (card list with countdown display)
- [x] Add timer CSS to `style.css`
- [x] Add `_getAudioCtx()` chime synthesis in `timer-panel.js` (reuses shared AudioContext)
- [x] Test named timers: "set a 5-minute timer called pasta", "cancel the pasta timer"
- [x] Test auto-stop: timer chimes and speaks "Timer complete: pasta" via `enqueueSpeak`

---

### Tool 3 — Weather (`WEATHER.md`) 🟢

> **Guide:** `markdown/WEATHER.md`  
> **Pipeline risk:** Low — one new router file, one new frontend module. Uses Open-Meteo (free, no API key, no account).

Follows the exact dossier intercept pattern already proven in the codebase. Backend calls
Open-Meteo's free public API. No authentication required.

- [x] `pip install httpx` (or confirm already present in `requirements.txt`)
- [x] Create `backend/weather.py` — `GET /weather` endpoint (lat/lon from `.env`, calls Open-Meteo)
- [x] Register `weather_router` in `backend/main.py`
- [x] Add `WEATHER_LAT`, `WEATHER_LON`, `WEATHER_UNITS` to `.env` / `.env.example`
- [x] Create `frontend/weather-panel.js` — `detectWeatherTrigger()`, `openWeatherPanel()`, render forecast cards
- [x] Import in `app.js` and add weather intercept block in `onstop` + `handleSend`
- [x] Add weather panel HTML to `index.html`
- [x] Add weather panel CSS to `style.css`
- [x] Test: "What's the weather?" → panel opens + LLM spoken summary of current conditions + 7-day forecast

#### Enhancement — Local JSON Cache & Historical Tracking 🟡

Persist each weather API response to a local JSON file on disk. Before calling Open-Meteo, check the cache; if the most recent entry is less than 1 hour old, serve the stored data instead. Every cache miss (i.e. a real API call) appends a timestamped record, building a passive historical log over time.

**Backend changes (`backend/weather.py`)**

- [x] Add `WEATHER_CACHE_FILE` to `.env` / `.env.example` (default: `memory/weather_cache.json`)
- [x] On startup, create `memory/weather_cache.json` if it does not exist (seed with `{"entries": []}`)
- [x] In `GET /weather` handler, before calling Open-Meteo:
  - Load `weather_cache.json`; read `entries[-1]` (most recent record)
  - If `entries[-1].fetched_at` exists and is within 3 600 s of `datetime.utcnow()`, return `entries[-1].data` directly with a `"source": "cache"` flag — no HTTP call made
- [x] On a cache miss, call Open-Meteo as normal; append `{ "fetched_at": "<ISO-8601 UTC>", "data": <response JSON> }` to `entries`; write the file back atomically (write to `.tmp` then `os.replace`)
- [x] Cap `entries` to the most recent N records (default 168, i.e. one week of hourly snapshots) — controlled by `WEATHER_HISTORY_MAX` in `.env`; trim oldest entries on write
- [x] Add `GET /weather/history` endpoint — returns the full `entries` array (timestamps + weather payloads) for potential future charting or trend queries

**Frontend changes (`frontend/weather-panel.js`)**

- [x] Display a small cache-age label in the weather panel header when serving cached data — e.g. `"Last updated 23 min ago"` — so the user knows the data is not live
- [x] Add a manual "Refresh" button (🔄) to the panel that calls `GET /weather?force=true` (bypass cache, always fetch live) and re-renders the panel
- [x] Support `force=true` query param in the backend: skip the age check and always call Open-Meteo when `force` is present

**`.env` additions**

```
WEATHER_CACHE_FILE=memory/weather_cache.json
WEATHER_HISTORY_MAX=168
```

**`.gitignore` addition**

- [x] Add `memory/weather_cache.json` to `.gitignore` (personal location data — do not commit)

#### Enhancement — Location-Aware Weather Queries 🟡

Allow the user to ask for weather at any named location by including it in the voice query. When no location is mentioned, fall back to the default coordinates stored in `.env` (Framingham, MA). When an ambiguous place name could match multiple locations (e.g. "Brighton" → Brighton, England or Brighton, MA), bias resolution toward the geographically closest match to the default home location.

**Trigger parsing (`frontend/weather-panel.js`)**

- [x] Extend `detectWeatherTrigger(transcript)` to extract an optional location token from the query:
  - Patterns to match: `"weather in <X>"`, `"weather for <X>"`, `"weather at <X>"`, `"show me the weather in <X>"`, `"what's the weather in <X>"`, `"let me see the weather in <X>"`, `"how's the weather in <X>"`, and common contractions / STT variants (`whats`, `how is`, etc.)
  - Capture everything after the preposition (`in` / `for` / `at`) up to end-of-string, stripping trailing punctuation
  - If no location token is found, set `location = null` — backend defaults to home coordinates
- [x] Pass the extracted `location` string (URL-encoded) as a query param when calling `GET /weather?location=<X>`; omit the param entirely when `location` is null

**Backend geocoding (`backend/weather.py`)**

- [x] Add `pip install geopy` (provides the `Nominatim` geocoder — OSM-based, free, no API key)
- [x] Write a `resolve_location(query: str, home_lat: float, home_lon: float) -> tuple[float, float, str]` helper:
  - Call `Nominatim(user_agent="starling-weather").geocode(query, exactly_one=False, limit=5)` to get up to 5 candidate results
  - For each candidate compute the geodesic distance from the home coordinates using `geopy.distance.geodesic`
  - Return the `(lat, lon, display_name)` of the **closest** candidate — this naturally resolves "Brighton" to Brighton, MA over Brighton, England when the home location is Framingham, MA
  - Raise `HTTPException(422)` if no candidates are returned (place name not recognised)
- [x] Update `GET /weather` to accept an optional `location: str = Query(None)` param:
  - If `location` is provided, call `resolve_location(location, home_lat, home_lon)` to get `(lat, lon, display_name)`
  - If `location` is `None`, use `WEATHER_LAT` / `WEATHER_LON` from `.env` and `display_name = "Framingham"` (or a configurable `WEATHER_DEFAULT_LABEL`)
  - Include `display_name` and `is_default_location: bool` in the response JSON so the frontend can label the panel correctly
- [x] Cache key should incorporate the resolved `(lat, lon)` pair rounded to 2 decimal places — location-specific responses are cached independently from the home location entry; format: `"entries"` keyed by `"<lat_rounded>_<lon_rounded>"` in `weather_cache.json`

**Frontend panel updates (`frontend/weather-panel.js`)**

- [x] Display the resolved `display_name` as the panel title (e.g. `"WEATHER — FRAMINGHAM, MA"` or `"WEATHER — LONDON, UK"`) instead of a hardcoded string
- [x] When `is_default_location` is `false`, show a subtle secondary label: `"showing results for <display_name>"` beneath the title so the user knows a location override is active
- [x] On a `422` response (unknown location), speak `"I couldn't find a weather location called [X]. Try being more specific."` via `enqueueSpeak` and do not open the panel

**`.env` additions**

```
WEATHER_DEFAULT_LABEL=Framingham
```

- [x] Add `geopy` to `requirements.txt`

---

### Tool 4 — News Briefing (`NEWS.md`) 🟢

> **Guide:** `markdown/NEWS.md`  
> **Pipeline risk:** Low — RSS via `feedparser`, free, no API key. Same intercept pattern as weather.

RSS feeds are parsed server-side to avoid CORS. Headline cards are rendered in a panel;
the LLM delivers a spoken briefing from structured context injection.

- [x] `pip install feedparser`
- [x] Create `backend/news.py` — `GET /news` endpoint, configurable RSS feed list, 2-minute cache
- [x] Register `news_router` in `backend/main.py`
- [x] Add `NEWS_FEEDS` (comma-separated RSS URLs), `NEWS_MAX_ITEMS`, `NEWS_CACHE_SECONDS` to `.env`
- [x] Create `frontend/news-panel.js` — `detectNewsTrigger()`, `openNewsPanel()`, render headline cards by source
- [x] Import in `app.js` and add news intercept block in `onstop` + `handleSend`
- [x] Add news panel HTML to `index.html`
- [x] Add news panel CSS to `style.css`
- [x] Test: "News briefing" → panel opens with headlines + LLM spoken summary of top stories

#### Enhancement — Category-Filtered News Queries 🟡

Allow the user to request headlines for a specific news category by including it in the voice query. When no category is mentioned, fall back to the default "World" feed. Categories map to distinct RSS feed subsets defined in `.env` — no new dependencies required.

**Supported categories (initial set)**

| Category token | Example trigger phrases | Feed tag |
|---|---|---|
| `world` | "news briefing", "show me the headlines", "what's in the news" | `world` |
| `us` / `america` | "US news", "American headlines", "display the US news" | `us` |
| `technology` / `tech` | "technology news", "tech headlines", "pull up the tech news" | `technology` |
| `finance` / `financial` / `business` | "financial headlines", "business news", "show me the finance news" | `business` |
| `science` | "science news", "science headlines" | `science` |
| `health` | "health news", "health headlines" | `health` |
| `sports` | "sports headlines", "sports news" | `sports` |
| `entertainment` | "entertainment news", "entertainment headlines" | `entertainment` |

**Trigger parsing (`frontend/news-panel.js`)**

- [x] Extend `detectNewsTrigger(transcript)` to extract an optional category token from the query:
  - Match category keywords anywhere in the phrase: `"show me the <category> news"`, `"pull up <category> headlines"`, `"display the <category> news"`, `"<category> briefing"`, `"what's happening in <category>"`, etc.
  - Normalise synonyms to canonical tags: `"tech"` → `technology`, `"financial"` / `"finance"` → `business`, `"american"` / `"america"` / `"us"` → `us`
  - If no recognisable category keyword is present, set `category = "world"` as the default
- [x] Pass the resolved `category` string as a query param when calling `GET /news?category=<tag>`

**Backend changes (`backend/news.py`)**

- [x] Update `NEWS_FEEDS` in `.env` from a single comma-separated list to a **category-keyed structure** — store as prefixed env vars:
  ```
  NEWS_FEEDS_WORLD=https://feeds.bbci.co.uk/news/rss.xml,...
  NEWS_FEEDS_US=https://feeds.npr.org/1001/rss.xml,...
  NEWS_FEEDS_TECHNOLOGY=https://feeds.arstechnica.com/arstechnica/index,...
  NEWS_FEEDS_BUSINESS=https://feeds.reuters.com/reuters/businessNews,...
  NEWS_FEEDS_SCIENCE=https://www.sciencedaily.com/rss/all.xml,...
  NEWS_FEEDS_HEALTH=https://feeds.webmd.com/rss/rss.aspx?RSSSource=RSS_PUBLIC,...
  NEWS_FEEDS_SPORTS=https://www.espn.com/espn/rss/news,...
  NEWS_FEEDS_ENTERTAINMENT=https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml,...
  ```
- [x] Update `GET /news` to accept `category: str = Query("world")` param; load the matching `NEWS_FEEDS_<CATEGORY>` var (case-insensitive); return `400` with a spoken-friendly message if the category key is not configured
- [x] Include `category` and `category_label` (display name) in the response JSON so the frontend can label the panel header accordingly
- [x] Cache key should incorporate the category tag — each category is cached independently with its own 2-minute TTL; format: `"<category>:<fetched_at>"` in the existing cache structure

**Frontend panel updates (`frontend/news-panel.js`)**

- [x] Display the resolved `category_label` in the panel header — e.g. `"NEWS — TECHNOLOGY"` or `"NEWS — WORLD HEADLINES"`
- [x] Render a row of category chip buttons at the top of the news panel (World · US · Tech · Business · Science · Health · Sports · Entertainment) — clicking a chip calls `GET /news?category=<tag>` and re-renders the panel inline without reopening it
- [x] Highlight the active chip with an accent border/colour so the user can see which category is currently displayed
- [x] On a `400` response (unconfigured category), speak `"I don't have a feed set up for [category] news."` via `enqueueSpeak` and do not change the panel state

**`.env` additions**

```
NEWS_FEEDS_WORLD=https://feeds.bbci.co.uk/news/rss.xml,https://rss.nytimes.com/services/xml/rss/nyt/World.xml
NEWS_FEEDS_US=https://feeds.npr.org/1001/rss.xml,https://rss.nytimes.com/services/xml/rss/nyt/US.xml
NEWS_FEEDS_TECHNOLOGY=https://feeds.arstechnica.com/arstechnica/index,https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml
NEWS_FEEDS_BUSINESS=https://feeds.reuters.com/reuters/businessNews,https://rss.nytimes.com/services/xml/rss/nyt/Business.xml
NEWS_FEEDS_SCIENCE=https://www.sciencedaily.com/rss/all.xml
NEWS_FEEDS_HEALTH=https://rss.nytimes.com/services/xml/rss/nyt/Health.xml
NEWS_FEEDS_SPORTS=https://www.espn.com/espn/rss/news,https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml
NEWS_FEEDS_ENTERTAINMENT=https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml
```

#### Enhancement — Cross-Source Story Synthesis 🟠

When headlines are fetched from multiple RSS sources for a given category, multiple outlets will often cover the same story with slightly different titles. Rather than displaying them as duplicate cards, use the LLM silently to cluster the raw headlines into deduplicated story groups. Each synthesised story card shows a single unified headline, a short LLM-generated summary sentence, and an expandable source list — one link per outlet that reported the same story.

**Backend changes (`backend/news.py`)**

- [x] After fetching and parsing all RSS feeds for a category, collect the raw headline list: `[{ "title", "link", "source_name", "published" }, ...]`
- [x] Pass the raw headline list to a `synthesise_headlines(headlines: list, llm_url: str) -> list` helper function that calls the local LLM (via `llama_server.py` or the active `LLM_BACKEND`) with a silent, non-streamed completion request:
  - Prompt instructs the model to group headlines that refer to the same real-world story, produce a single neutral synthesised headline per group, write one concise summary sentence per group, and return structured JSON:
    ```json
    [
      {
        "headline": "Synthesised story headline",
        "summary": "One-sentence plain-prose summary.",
        "sources": [
          { "name": "BBC News", "title": "Original BBC title", "link": "https://...", "published": "ISO-8601" },
          { "name": "Reuters",  "title": "Original Reuters title", "link": "https://...", "published": "ISO-8601" }
        ]
      }
    ]
    ```
  - Use `response_format: { type: "json_object" }` (llama-server supports this via grammar constraints) to enforce valid JSON output without post-processing
  - Cap input at `NEWS_SYNTHESIS_MAX_HEADLINES` headlines (default 40) before sending to the LLM to stay within context
- [x] If the LLM call fails or returns malformed JSON, fall back gracefully to the raw unsynthesised headline list so the panel always renders something
- [x] Include synthesised groups in the cached response — the synthesis result is stored alongside the raw feed data; re-synthesis only occurs on a real cache miss (not on every request)
- [x] Add `NEWS_SYNTHESIS_ENABLED` flag to `.env` (default `true`) — when `false`, skip the LLM step entirely and return raw headlines, useful for debugging or low-power sessions
- [x] Add `NEWS_SYNTHESIS_MAX_HEADLINES` to `.env` (default `40`) — number of raw headlines fed to the LLM per synthesis call

**Frontend panel updates (`frontend/news-panel.js`)**

- [x] Replace the flat headline card list with synthesised story cards. Each card renders:
  - **Synthesised headline** — prominent, full-width title text
  - **Summary sentence** — muted smaller text directly beneath the headline
  - **Source pills row** — compact inline chips, one per outlet (e.g. `BBC · Reuters · NYT`); each chip is a clickable `<a target="_blank">` link to the original article
  - **Published timestamp** — taken from the most-recent `published` value among the grouped sources
- [x] Add a subtle multi-source indicator (e.g. `3 sources` label) on cards with more than one outlet so the user immediately knows it is a merged story
- [x] Expand/collapse the full source list on card click — show just the chips by default; expand to a stacked list of `[Source name] — Original title — link` rows when the user clicks the card body
- [x] When `NEWS_SYNTHESIS_ENABLED=false` (raw mode), render the original flat card layout unchanged — no regression in fallback path
- [x] Show a brief `"Synthesising headlines…"` status message in the panel header while the silent LLM call is in flight, replaced by the category label once complete

**LLM prompt template (stored in `backend/news.py` as a module-level constant)**

```python
NEWS_SYNTHESIS_PROMPT = """
You are a news editor. Below is a JSON array of raw headlines from multiple news sources.
Group headlines that refer to the same real-world story.
For each group, produce:
- "headline": a single neutral synthesised headline (plain prose, no markdown)
- "summary": one concise sentence summarising the story (plain prose, no markdown)
- "sources": the original objects for every headline in the group, unchanged

Return ONLY a valid JSON array. No commentary, no markdown fences.

Headlines:
{headlines_json}
""".strip()
```

**`.env` additions**

```
NEWS_SYNTHESIS_ENABLED=true
NEWS_SYNTHESIS_MAX_HEADLINES=40
```

---

### Tool 5 — Stocks & Crypto (`STOCKS.md`) ✅

> **Guide:** `markdown/STOCKS.md`  
> **Pipeline risk:** Low-Medium — `yfinance` is an unofficial Yahoo Finance scraper (personal use acceptable). Occasionally breaks when Yahoo changes response format; not suitable for production.

Same intercept and panel pattern as weather and news. No API key required.

- [x] `pip install yfinance tzdata` — `yfinance-1.3.0`, `tzdata-2026.2` installed
- [x] Create `backend/stocks.py` — `GET /stocks` endpoint; parallel ticker fetch via `asyncio.gather + run_in_executor`; 5-minute in-memory cache; `DELETE /stocks/cache`; market-hours detection (`_is_us_market_open`) using `ZoneInfo`; Windows-safe LLM context string
- [x] Register `stocks_router` in `backend/main.py`
- [x] Add `STOCKS_WATCHLIST`, `CRYPTO_WATCHLIST`, `STOCKS_CACHE_SECONDS`, `STOCKS_CURRENCY_SYMBOL` to `.env` / `.env.example`
- [x] Create `frontend/stocks-panel.js` — `detectMarketTrigger()` (returns `'stocks'` / `'crypto'` / `'all'`), `openMarketPanel(filter)`, `closeMarketPanel()`, filter tab wiring, stagger card animation (`--card-delay` CSS variable)
- [x] Import in `app.js`; add `enterMarketMode()` / `exitMarketMode()`; add market intercept in `_routeInput`; update `dismissAllToolPanels()` to call `exitMarketMode()`
- [x] Add `.mkt-panel` HTML to `index.html` (inside `.body-cols`, same slot as news panel); add `MKT OPEN/CLOSED` footer badge (`#ftr-mkt-status`)
- [x] Add market panel CSS + `mkt-mode` layout rules (mirrors `news-mode` — panel slides in at 60% width, `col-left` shrinks to 37%); stagger animation reuses existing `newsCardIn` keyframe
- [x] Tightened `detectMarketTrigger` — bare "stock" no longer fires the panel; requires a qualifying phrase (e.g. "stock briefing", "market update", specific ticker names like "check NVIDIA")
- [x] Test: "market briefing" / "show me crypto" / "check NVIDIA" → panel opens + LLM spoken market summary

#### Enhancement — JSON Watchlist File 🟢

Replace the flat `STOCKS_TICKERS` env var with a user-editable `memory/watchlist.json` file that defines which equities and crypto tokens to track, organised into named groups. The file is the single source of truth — no code change required to add, remove, or reorganise tickers.

**Watchlist file format (`memory/watchlist.json`)**

```json
{
  "groups": [
    {
      "label": "Indices",
      "tickers": ["^GSPC", "^DJI", "^IXIC", "^RUT"]
    },
    {
      "label": "Tech",
      "tickers": ["AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN"]
    },
    {
      "label": "Crypto",
      "tickers": ["BTC-USD", "ETH-USD", "SOL-USD"]
    },
    {
      "label": "Personal",
      "tickers": []
    }
  ],
  "default_group": "all"
}
```

- `"groups"` — ordered list of named ticker groups; groups are rendered as tabs in the stocks panel
- `"default_group"` — which group tab is shown first when the panel opens; set to `"all"` to flatten all tickers into a single view, or a group `label` to open that tab directly
- The file is plain JSON — users add/remove tickers by editing it directly; no restart required (backend reads the file on each cache miss)

**Backend changes (`backend/stocks.py`)**

- [ ] On startup, check for `memory/watchlist.json`; if absent, write a default template (the example above) so first-run works without manual setup
- [ ] Replace `STOCKS_TICKERS` env var loading with `load_watchlist() -> dict` that reads and validates `memory/watchlist.json`; raise a clear startup warning (not a crash) if the file is malformed
- [ ] `GET /stocks` flattens all groups into a single ticker list for the `yfinance` batch call, then re-groups the results by `label` before returning — the response shape becomes:
  ```json
  {
    "groups": [
      {
        "label": "Tech",
        "tickers": [
          { "symbol": "AAPL", "price": 213.45, "change": 1.23, "change_pct": 0.58, "name": "Apple Inc." },
          ...
        ]
      }
    ],
    "default_group": "all",
    "fetched_at": "2026-05-14T14:32:00Z",
    "source": "live"
  }
  ```
- [ ] Retain the existing `STOCKS_CACHE_SECONDS` TTL — cached response stores the full grouped structure
- [ ] Add `GET /stocks/watchlist` endpoint — returns the raw `watchlist.json` content so the frontend can render an edit UI in the future without needing filesystem access
- [ ] Add `PUT /stocks/watchlist` endpoint — accepts a full watchlist JSON body, validates it (checks all required keys, rejects unknown ticker formats), and writes it back to `memory/watchlist.json` atomically; invalidates the current cache on success

**Frontend panel updates (`frontend/stocks-panel.js`)**

- [ ] Render group tabs at the top of the stocks panel, one tab per `groups[].label` plus an `All` tab that flattens everything — active tab highlighted with accent colour
- [ ] `default_group: "all"` opens the `All` tab; any other value selects the matching group tab on open
- [ ] Each ticker row shows: symbol, full company/asset name, current price, change amount, and `±pct%` coloured green/red
- [ ] Indices group (tickers starting with `^`) rendered without a price currency symbol — display as plain number with change

**`.env` change**

- [ ] Remove `STOCKS_TICKERS` from `.env` / `.env.example` — superseded by `watchlist.json`
- [ ] Add `STOCKS_WATCHLIST_FILE` to `.env` / `.env.example` (default: `memory/watchlist.json`)

**`.gitignore` addition**

- [ ] Add `memory/watchlist.json` to `.gitignore` — personal portfolio data; do not commit

#### Enhancement — Interactive Chart Dashboard 🟡

Replace the flat ticker grid with a full-panel chart dashboard. The panel is divided into **6 fixed tiles** in a 3 × 2 grid. The top row holds three always-visible market index charts; the bottom row holds a crypto index chart, a watchlist stocks tile, and a watchlist crypto tile. All charts are rendered with [Chart.js](https://www.chartjs.org/) (no new backend dependency — historical OHLC data is fetched from `yfinance`).

**Panel layout (6-tile grid)**

```
┌─────────────────┬─────────────────┬─────────────────┐
│  S&P 500        │  NASDAQ         │  Dow Jones      │
│  (^GSPC)        │  (^IXIC)        │  (^DJI)         │
├─────────────────┼─────────────────┼─────────────────┤
│  Bitcoin        │  My Stocks      │  My Crypto      │
│  + Ethereum     │  (watchlist)    │  (watchlist)    │
└─────────────────┴─────────────────┴─────────────────┘
```

- Tiles 1–3 (S&P 500, NASDAQ, Dow Jones) — fixed index charts, always shown, not user-configurable
- Tile 4 (Bitcoin + Ethereum) — two-line overlay chart on the same axis; both lines always shown together as the baseline crypto benchmark
- Tile 5 (My Stocks) — single rotating chart; a **ticker selector dropdown** above the chart lets the user switch between any equity in their watchlist groups
- Tile 6 (My Crypto) — same as Tile 5 but scoped to crypto tickers from the watchlist (`BTC-USD`, `ETH-USD`, `SOL-USD`, etc.)

**Timeframe controls**

- [ ] Each tile has its own timeframe pill strip: `1D · 1W · 1M · 3M · 1Y · ALL` — clicking a pill re-fetches and re-renders that tile only
- [ ] Default timeframe on panel open: `1M` for all tiles
- [ ] Timeframe selection is preserved per-tile in the panel's local state for the duration of the session (not persisted to localStorage)

**Backend changes (`backend/stocks.py`)**

- [ ] Add `GET /stocks/history` endpoint accepting `ticker: str`, `period: str` (`1d`, `1wk`, `1mo`, `3mo`, `1y`, `max`) and `interval: str` (auto-derived from period: `1d`→`5m`, `1wk`→`1h`, `1mo`→`1d`, `3mo`→`1d`, `1y`→`1wk`, `max`→`1mo`):
  - Calls `yfinance.Ticker(ticker).history(period=period, interval=interval)`
  - Returns `{ "ticker", "period", "interval", "points": [{ "t": <unix_ms>, "o", "h", "l", "c", "v" }] }`
- [ ] Cache each `(ticker, period)` pair independently — TTL varies by period: `1d`→`5 min`, `1wk`→`15 min`, `1mo`→`1 hr`, longer periods→`6 hr`
- [ ] Batch endpoint `GET /stocks/history/batch` — accepts `tickers` (comma-separated) and a single `period`; returns an array of the same structure above — used on panel open to pre-fetch all 6 tiles in one round trip

**Frontend — chart rendering (`frontend/stocks-panel.js`)**

- [ ] Add Chart.js via CDN in `index.html`: `<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>`
- [ ] Add `chartjs-adapter-date-fns` adapter for time-scale x-axis: `<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>`
- [ ] Write `renderTile(canvasId, datasets, options)` — thin wrapper around `new Chart(...)` with shared defaults: dark background (`#0a0a0a`), no border radius on points, grid lines in `rgba(255,255,255,0.06)`, x-axis as `type: "time"`, tooltip showing date + value on hover
- [ ] Index tiles (1–3): single-line chart, line colour white (`#ffffff`), area fill to `rgba(255,255,255,0.04)`
- [ ] BTC + ETH tile (4): two-line overlay — BTC in amber (`#f7931a`), ETH in indigo (`#627eea`); shared time axis, independent y-axes (left = BTC, right = ETH) so price scale difference doesn't flatten either line
- [ ] My Stocks tile (5): single line in cyan (`#88ddff`); selector dropdown above chart populated from watchlist equity groups; switching dropdown destroys and re-creates the Chart.js instance for that canvas
- [ ] My Crypto tile (6): single line in violet (`#bb88ff`); selector dropdown populated from watchlist crypto group
- [ ] On panel open, call `GET /stocks/history/batch?tickers=^GSPC,^IXIC,^DJI,BTC-USD,ETH-USD,<first_equity>,<first_crypto>&period=1mo` — render all 6 tiles from the single response
- [ ] Timeframe pill click: call `GET /stocks/history?ticker=<tile_ticker>&period=<period>` for that tile only; update chart data via `chart.data.datasets[0].data = newPoints; chart.update()`
- [ ] On panel resize (window `resize` event): call `chart.resize()` on all active Chart.js instances so tiles fill available space correctly

**Frontend — panel layout CSS (`style.css`)**

- [ ] Add `.stocks-dashboard` grid: `display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); gap: 1px; background: #1a1a1a;` — 1 px gap creates hairline dividers between tiles
- [ ] Each `.stocks-tile`: `background: #0a0a0a; padding: 12px; display: flex; flex-direction: column;`
- [ ] Tile header: `display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;` — left side shows ticker symbol + full name in small-caps; right side shows current price + `±pct%` chip
- [ ] Timeframe pills: `display: flex; gap: 4px; margin-bottom: 8px;` — each pill `font-size: 0.65rem; padding: 2px 6px; border: 1px solid #333; border-radius: 3px; cursor: pointer;`; active pill `background: #fff; color: #000`
- [ ] Canvas element fills remaining tile height: `flex: 1; min-height: 0;`
- [ ] On small viewports (`< 900 px`): collapse to single-column stacked layout — `grid-template-columns: 1fr`

**`.env` additions**

```
STOCKS_CHART_DEFAULT_PERIOD=1mo
STOCKS_HISTORY_CACHE_SECONDS_SHORT=300
STOCKS_HISTORY_CACHE_SECONDS_LONG=21600
```

#### Enhancement — Persistent Local JSON Cache 🟢

Persist every `yfinance` response to a local JSON file on disk. Before calling Yahoo Finance, check the cache; if the stored entry for a given `(ticker, period)` pair is less than 24 hours old, serve the stored data directly — no network call made. This avoids redundant API hits across restarts and sessions, and builds a passive historical record of past snapshots over time.

**Cache file structure (`memory/stocks_cache.json`)**

```json
{
  "quote": {
    "AAPL": { "fetched_at": "2026-05-14T14:00:00Z", "data": { ... } },
    "BTC-USD": { "fetched_at": "2026-05-14T14:00:00Z", "data": { ... } }
  },
  "history": {
    "AAPL__1mo": { "fetched_at": "2026-05-14T14:00:00Z", "data": [ ... ] },
    "^GSPC__1y": { "fetched_at": "2026-05-14T08:00:00Z", "data": [ ... ] }
  }
}
```

- `"quote"` — keyed by ticker symbol; stores the latest price, change, and metadata returned by `GET /stocks`
- `"history"` — keyed by `"<ticker>__<period>"`; stores the OHLCV point arrays returned by `GET /stocks/history`
- All timestamps are ISO-8601 UTC strings for human readability when inspecting the file directly

**TTL rules by data type**

| Data type | Cache TTL | Rationale |
|---|---|---|
| Quote (current price + change) | 1 hour | Matches the weather cache pattern — fresh enough for a personal dashboard; avoids hammering Yahoo Finance during market hours |
| History `1d` period | 1 hour | Intraday data changes frequently during market hours |
| History `1wk` / `1mo` | 24 hours | Daily candles change at most once per market session |
| History `3mo` / `1y` / `max` | 7 days | Weekly/monthly candles are stable; no need to re-fetch frequently |

**Backend changes (`backend/stocks.py`)**

- [ ] Add `STOCKS_CACHE_FILE` to `.env` / `.env.example` (default: `memory/stocks_cache.json`)
- [ ] On startup, create `memory/stocks_cache.json` if it does not exist (seed with `{"quote": {}, "history": {}}`)
- [ ] Write `load_stocks_cache() -> dict` and `save_stocks_cache(cache: dict)` helpers — `save` writes atomically to a `.tmp` file then `os.replace` to prevent corruption on write
- [ ] In `GET /stocks` handler, before calling `yfinance`:
  - For each ticker, check `cache["quote"][ticker]["fetched_at"]`; if within 86 400 s of `datetime.utcnow()`, use stored data — skip the `yfinance` call for that ticker
  - Only fetch tickers whose cache entry is absent or expired; merge fresh results back into the cache and save
  - Include `"source": "cache"` or `"source": "live"` per ticker in the response so the frontend can label freshness
- [ ] In `GET /stocks/history` handler:
  - Cache key: `"<ticker>__<period>"` in `cache["history"]`
  - Apply the TTL from the table above based on `period` value
  - On hit, return stored points with `"source": "cache"`; on miss, fetch from `yfinance`, store, and return with `"source": "live"`
- [ ] In `GET /stocks/history/batch`:
  - Evaluate each `(ticker, period)` pair independently against the cache — partial cache hits are fine; only the stale/missing pairs trigger a `yfinance` call
  - Merge and return all results in a single response
- [ ] Add `GET /stocks/cache/status` endpoint — returns per-ticker and per-history-key `fetched_at` timestamps and age in seconds; useful for debugging staleness without opening the JSON file
- [ ] Add `DELETE /stocks/cache` endpoint — clears `stocks_cache.json` back to the seed state; allows a forced full refresh without editing the file manually
- [ ] Remove the now-redundant in-memory `STOCKS_CACHE_SECONDS` TTL variable — the on-disk cache with per-key TTLs supersedes it; retire `STOCKS_CACHE_SECONDS` from `.env.example`

**Frontend panel updates (`frontend/stocks-panel.js`)**

- [ ] Display a staleness label in each tile's header when `source === "cache"` — e.g. `"as of 3 hr ago"` — so the user knows they are viewing stored data
- [ ] Add a `"Refresh"` icon button (🔄) to each tile header that appends `?force=true` to the history or quote fetch for that tile, bypassing the cache for that specific `(ticker, period)` pair
- [ ] Support `force=true` query param in all three backend endpoints (`/stocks`, `/stocks/history`, `/stocks/history/batch`) — when present, skip the cache read and always call `yfinance`; write the fresh result back to the cache as normal

**`.env` additions**

```
STOCKS_CACHE_FILE=memory/stocks_cache.json
```

**`.gitignore` addition**

- [ ] Add `memory/stocks_cache.json` to `.gitignore` — contains personal watchlist pricing data; do not commit

#### Enhancement — Historical Data View with Smart Gap-Fill 🟡

Store historical candle data in `stocks_history.json` once fetched. On every subsequent request for a `(ticker, window)` pair, the backend checks the last stored candle date and fetches only the gap (last stored date → today), appending new candles to the existing series. Users see instant chart renders from stored data; the network call covers only missing time. Supports **7D · 1M · 3M · 6M · 1Y · 5Y · 10Y** windows.

**Time windows and candle intervals**

| Window | yfinance period | Candle interval | Gap re-fetched on request |
|---|---|---|---|
| 7D | `7d` | `1h` | Every request (fast-moving intraday) |
| 1M | `1mo` | `1d` | Daily (one new candle per market session) |
| 3M | `3mo` | `1d` | Daily |
| 6M | `6mo` | `1d` | Daily |
| 1Y | `1y` | `1wk` | Weekly |
| 5Y | `5y` | `1wk` | Weekly |
| 10Y | `10y` | `1mo` | Monthly |

**Storage file (`memory/stocks_history.json`)**

```json
{
  "AAPL__1y": {
    "fetched_at": "2026-05-14T14:00:00Z",
    "interval": "1wk",
    "candles": [
      { "t": 1715644800000, "o": 172.30, "h": 179.10, "l": 171.50, "c": 178.20, "v": 58423100 },
      "..."
    ]
  },
  "BTC-USD__1m": {
    "fetched_at": "2026-05-14T14:00:00Z",
    "interval": "1d",
    "candles": [ "..." ]
  }
}
```

- Key format: `"<ticker>__<window>"` (e.g. `AAPL__1y`, `BTC-USD__3m`)
- `fetched_at` records when the most recent gap-fill completed
- `candles` are sorted ascending by `t` (Unix ms UTC); no duplicates
- Data is **never deleted** from the file — only extended; this passively builds a personal price history archive over time

**Gap-fill algorithm**

1. Load stored series for `(ticker, window)` from `stocks_history.json`
2. **First request (empty)**: call `yf.Ticker(t).history(period=yf_period, interval=interval)` for the full range; store; return
3. **Subsequent request**: read `candles[-1]["t"]` → derive `start_date = last_candle_date + 1 interval unit`
4. Call `yf.Ticker(t).history(start=start_date, end=datetime.utcnow(), interval=interval)` — fetches only the gap
5. Deduplicate on `t`, merge new candles into the stored array (append only), re-sort ascending
6. Update `fetched_at`; save atomically; return the full stored array
7. If the gap is zero (last candle is today), skip the network call entirely and return from disk

**Backend changes (`backend/stocks.py`)**

- [ ] Add `STOCKS_HISTORY_FILE` to `.env` / `.env.example` (default: `memory/stocks_history.json`)
- [ ] On startup, create `stocks_history.json` if absent (seed: `{}`)
- [ ] Write `load_history_cache() -> dict` and `save_history_cache(cache: dict)` — atomic write via `.tmp` + `os.replace` (same pattern as quote cache)
- [ ] Write `_gap_fill(ticker, window) -> list[dict]` implementing the algorithm above; maps `window` → `(yf_period, interval)` via a lookup table
- [ ] Update `GET /stocks/history?ticker=&window=` to use `_gap_fill()`; response includes `"source": "cache"` (no new candles) or `"source": "gap_fill"` (new candles appended) so the frontend can show a freshness label
- [ ] On the first response for a ticker, fire a `BackgroundTask` that pre-fills all other windows for that ticker in ascending cost order (`7d → 1m → 3m → 6m → 1y → 5y → 10y`) — so subsequent window switches are instant
- [ ] Add `DELETE /stocks/history?ticker=&window=` — omit `window` to clear all windows for that ticker; omit both to wipe the entire file (useful for forced re-fetch)

**Frontend changes (`frontend/stocks-panel.js`)**

- [ ] Window selector pill strip labels: `7D · 1M · 3M · 6M · 1Y · 5Y · 10Y`; map to backend `window` values `7d · 1m · 3m · 6m · 1y · 5y · 10y`
- [ ] Show `"Loading…"` placeholder on first chart open for a ticker while the full-period fetch runs; subsequent opens for the same ticker render from gap-filled disk data and feel instant
- [ ] Display `"Updated <relative time>"` label below the chart sourced from the `fetched_at` field (e.g. "Updated 3 hr ago")

#### Enhancement — Clickable Tile Detail View 🟡

Any ticker card in the market grid is clickable. Clicking it slides the grid out of view and renders a full-width detail pane inside `.mkt-panel` showing an interactive Chart.js line chart for that ticker, a time window pill strip, a stats strip, and a "Hear Briefing" button. The Back button returns to the grid.

**Detail view layout**

```
┌──────────────────────────────────────────────────────┐
│  ← Back    AAPL — Apple Inc.       $213.45 ▲ +0.58%  │
├──────────────────────────────────────────────────────┤
│  [ 7D ][ 1M ][ 3M ][ 6M ][ 1Y ][ 5Y ][ 10Y ]        │
├──────────────────────────────────────────────────────┤
│                                                      │
│                  Line chart (Chart.js)               │
│          ← crosshair tooltip: date + OHLCV →         │
│                                                      │
├──────────────────────────────────────────────────────┤
│  52W High: $245.50  │  52W Low: $164.08  │  Vol: 58M │
│  Mkt Cap: $3.2T     │  P/E: 34.2         │  Yield: — │
│               [ ♪ Hear Briefing ]                    │
└──────────────────────────────────────────────────────┘
```

**Frontend changes (`frontend/stocks-panel.js`)**

- [ ] Add `data-symbol` attribute to each `.mkt-card` at render time; bind a `click` handler that calls `openDetailView(symbol)`
- [ ] `openDetailView(symbol)`: hide `.mkt-grid`; show `.mkt-detail`; populate header (symbol, full name, current price, % change chip); load chart for default window `1M`; populate stats strip from the cached `GET /stocks` data
- [ ] `closeDetailView()`: hide `.mkt-detail`; restore `.mkt-grid`; destroy the active Chart.js instance to free canvas memory; called by Back button and `closeMarketPanel()`
- [ ] Chart.js area/line chart in `#mkt-detail-canvas`:
  - Lazy-load Chart.js and `chartjs-adapter-date-fns` on first `openDetailView()` call (dynamic `import()` or injected `<script>`) so they have zero impact on initial page load
  - Line colour: green (`#4ade80`) on positive session, red (`#f87171`) on negative; area fill: semi-transparent tint of the line colour at 0.08 opacity
  - X-axis: `type: "time"`; labels auto-formatted based on window (`7D` → hours, `1M–6M` → day/month, `1Y–10Y` → month/year)
  - Y-axis: price-formatted ticks; no currency prefix for index tickers (`^` prefix)
  - Custom crosshair: vertical hairline follows cursor via `afterDraw` plugin hook; tooltip card shows `Date`, `Close`, `Open`, `High`, `Low`, `Volume`
- [ ] Window pill click: call `GET /stocks/history?ticker=<symbol>&window=<w>`; swap chart data via `chart.data.datasets[0].data = newPoints; chart.update('active')`; update the "Updated" timestamp label
- [ ] Stats strip: populated from `fast_info` fields already in `GET /stocks` response (52W high/low, volume, market cap); extend with `yf.Ticker().info` fields (P/E, dividend yield) if available — backend can optionally include these in the `GET /stocks` response
- [ ] `Escape` key while detail view is open calls `closeDetailView()`
- [ ] On panel `resize` event: call `chart.resize()` so the canvas fills the updated panel dimensions

**CSS additions (`style.css`)**

- [ ] `.mkt-detail` — `display: none; flex-direction: column; width: 100%; height: 100%;` — toggled with `.mkt-grid` (one visible at a time)
- [ ] `.mkt-detail-header` — flex row; Back button `←` far left; symbol + full name centre-left; price + change chip far right
- [ ] `.mkt-window-pills` — pill strip styled identically to existing `.mkt-tabs`; active pill `background: #fff; color: #000`
- [ ] `#mkt-detail-canvas` — `flex: 1; min-height: 0;` so it fills remaining panel height after header + pills + stats
- [ ] `.mkt-stats-strip` — 3-column CSS grid; small monospace key/value pairs; muted text; full-width top separator border
- [ ] `.mkt-hear-btn` — full-width action button at base of stats strip; same visual style as `.mkt-refresh-btn`
- [ ] On small viewports (< 600 px): hide the stats strip secondary row (P/E, yield); scale chart font sizes down

#### Enhancement — LLM Ticker Briefing on Tile Expand 🟢

When the detail view opens for a ticker, the backend computes a rich context string from stored historical candles and current quote data. The frontend feeds this context to the existing `sendToOllama()` call, producing a 2–3 sentence spoken briefing that plays automatically as the chart loads. A "Hear Briefing" button re-triggers it at any time; changing the time window re-triggers it for the new period.

**Context builder inputs (all computed from stored data — no extra yfinance calls unless history cache is empty)**

- Current price and today's % change (direction, OPEN/CLOSED/AFTER-HOURS status)
- 52-week high and low; % distance current price is from the 52W high
- Historical performance over the selected window: % change from first stored candle to last stored candle
- Peak close and date within the window; trough close and date
- S&P 500 (`^GSPC`) % change over the same window — market benchmark comparison
- Over/under-performance delta: `ticker_pct_change − sp500_pct_change`

**LLM prompt template (filled server-side in `GET /stocks/briefing`)**

```
You are a financial data narrator for a personal stock dashboard.
Deliver a concise spoken briefing (2–3 sentences, max 60 words) for {TICKER} ({FULL_NAME}).

Context:
- Current price: {PRICE} ({PCT_TODAY}% today, market is {STATUS})
- Over the past {WINDOW_LABEL}: {PCT_WINDOW}% ({FIRST_PRICE} → {LAST_PRICE})
- 52W range: ${LOW_52W} – ${HIGH_52W}; currently {PCT_FROM_HIGH}% below 52W high
- Window peak: ${PEAK_CLOSE} on {PEAK_DATE}; trough: ${TROUGH_CLOSE} on {TROUGH_DATE}
- S&P 500 over same period: {SP500_PCT}% — ticker is {OVER/UNDER}performing the market by {DELTA}%

Do not give financial advice. Be factual, conversational, and direct. Avoid filler phrases.
```

**Backend changes (`backend/stocks.py`)**

- [ ] Add `GET /stocks/briefing?ticker=&window=` endpoint:
  - Load current quote from quote cache (or fetch live if stale)
  - Load stored candles for `(ticker, window)` from `stocks_history.json`; if absent, call `_gap_fill()` synchronously before building context
  - Fetch `^GSPC` candles for the same window (from history cache — trigger gap-fill if absent)
  - Compute all values in the prompt template; handle edge cases (crypto: omit P/E; missing benchmark: omit benchmark sentence)
  - Return `{ "ticker": str, "window": str, "llm_context": str }` — the caller feeds this directly to `sendToOllama()`
- [ ] All arithmetic uses `candles[-1]["c"]` (last close) and `candles[0]["c"]` (first close) from the stored array — no rounding surprises from intermediate fetches
- [ ] If `^GSPC` gap-fill fails (network error): omit the benchmark lines from the prompt rather than returning an error
- [ ] Handle crypto tickers gracefully: substitute `"Crypto market"` for the benchmark label when `^GSPC` is not a meaningful comparator; or use `BTC-USD` as the crypto benchmark

**Frontend changes (`frontend/stocks-panel.js`)**

- [ ] On `openDetailView(symbol)`: after chart renders, immediately call `GET /stocks/briefing?ticker=<symbol>&window=1m`; on success, call `sendToOllama(data.llm_context, { ephemeralMessages: [...] })` so the briefing speaks automatically as the chart loads
- [ ] `.mkt-hear-btn` click: re-triggers `GET /stocks/briefing` + `sendToOllama` for the currently active window; disable button + show spinner while fetching; re-enable on completion
- [ ] Window pill change: re-trigger the briefing automatically for the new window (the changed period gives meaningfully different context)
- [ ] If `sendToOllama` is already speaking, queue the new briefing rather than interrupting the current one; cancel the queue if the detail view is closed before it fires

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

### Enhancement — Toolkit Awareness & Fuzzy Tool Recovery 🟡

Two tiers of the same idea: making Starling genuinely aware of what she can do, and recovering gracefully when a tool trigger almost — but not quite — matched.

---

#### Tier 1 — Toolkit Self-Awareness (Simple) 🟢

Inject a structured toolkit manifest into Starling's system prompt so she can answer natural questions like *"What can you do?"*, *"Do you have a weather tool?"*, or *"What tools are available?"* without hallucinating.

**System prompt injection (`backend/main.py` or `backend/llama_server.py`)**

- [ ] Define a `TOOLKIT_MANIFEST` constant — a plain-prose block listing every active tool, its trigger phrases, and a one-sentence description. Example:

  ```
  You have access to the following tools. When the user asks what you can do or which tools are available, describe these tools accurately and naturally.

  - Time & Date: answers questions like "what time is it" or "what's today's date" — reads the local system clock directly, no internet required.
  - Timers: sets and cancels countdown timers ("set a 5-minute timer called pasta", "cancel the pasta timer").
  - Weather: fetches the current forecast ("what's the weather?", "weather in London") via Open-Meteo — no API key required.
  - News Briefing: reads RSS headlines by category ("news briefing", "show me the tech news").
  - Stocks & Crypto: shows live market prices ("what's the market doing?", "how is Apple trading?").
  - Wake Word: hands-free activation — say "Hey Starling" to start listening without pressing a button.
  - In-UI Browser: opens a sandboxed web panel ("open YouTube", "search Google for…").
  - Ideas Tracker: captures and retrieves spoken ideas ("store my idea", "show my ideas").
  - Voice Journal: multi-press dictation with LLM summary ("start a journal entry").
  - Wikipedia RAG: grounded encyclopedia Q&A ("Wikipedia search for black holes").
  - Google Calendar: reads today's or this week's schedule ("what's on my schedule today?").
  - Gmail: reads, summarises, and trashes emails ("view my emails", "summarise that email").
  ```

- [ ] Append the `TOOLKIT_MANIFEST` block to the existing `LLAMA_SYSTEM_PROMPT` value at startup — separated by a blank line so it reads as a natural continuation of Starling's persona
- [ ] Add `TOOLKIT_MANIFEST_ENABLED` flag to `.env` / `.env.example` (default `true`) — when `false`, the manifest is omitted (useful for token-budget-constrained models)
- [ ] Keep the manifest in sync with the `TOOL_INTERCEPT_ORDER` list — when a new tool is added to `app.js`, update the manifest constant at the same time (single-file maintenance)
- [ ] Test: "What can you do?" → Starling describes all available tools in natural prose without markdown
- [ ] Test: "Do you have a timer?" → confirms yes and explains trigger phrases
- [ ] Test: "Can you check my email?" → confirms capability and explains how to trigger it

---

#### Tier 2 — Fuzzy Tool Detection & Confirmation (Complex) 🟡

When STT transcription produces a near-miss (garbled audio, background noise, hesitant speech), detect that the utterance was *probably* a tool trigger, confirm with the user via a spoken prompt, and open the tool on affirmation. Prevents the LLM from receiving noise fragments as chat input.

**Detection strategy (`frontend/app.js` or new `frontend/fuzzy-tool-detect.js`)**

- [ ] Define a `FUZZY_TOOL_MAP` — an array of `{ toolName, canonicalTriggers, fuzzyKeywords, openFn }` entries, one per tool. `fuzzyKeywords` are the core semantic words that should appear even in a degraded transcript:

  ```js
  const FUZZY_TOOL_MAP = [
    { toolName: 'Timer',    canonicalTriggers: ['set a timer', 'cancel timer'],         fuzzyKeywords: ['timer', 'remind', 'countdown', 'minutes', 'seconds'],   openFn: () => detectTimerTrigger(transcript) },
    { toolName: 'Weather',  canonicalTriggers: ['what\'s the weather', 'weather in'],   fuzzyKeywords: ['weather', 'forecast', 'temperature', 'rain', 'cloud'],   openFn: () => detectWeatherTrigger(transcript) },
    { toolName: 'News',     canonicalTriggers: ['news briefing', 'headlines'],           fuzzyKeywords: ['news', 'headlines', 'briefing', 'stories', 'latest'],    openFn: () => detectNewsTrigger(transcript) },
    { toolName: 'Stocks',   canonicalTriggers: ['what\'s the market', 'how is apple'],  fuzzyKeywords: ['stocks', 'market', 'shares', 'trading', 'crypto', 'price'], openFn: () => detectMarketTrigger(transcript) },
    { toolName: 'Calendar', canonicalTriggers: ['what\'s on my schedule', 'my calendar'], fuzzyKeywords: ['calendar', 'schedule', 'meeting', 'appointment', 'today'], openFn: () => detectCalendarTrigger(transcript) },
    { toolName: 'Email',    canonicalTriggers: ['view my emails', 'check my email'],    fuzzyKeywords: ['email', 'gmail', 'inbox', 'unread', 'messages'],           openFn: () => detectGmailTrigger(transcript) },
    { toolName: 'Journal',  canonicalTriggers: ['start a journal entry'],               fuzzyKeywords: ['journal', 'diary', 'entry', 'log', 'record'],             openFn: () => detectJournalStartTrigger(transcript) },
    { toolName: 'Ideas',    canonicalTriggers: ['store my idea', 'show my ideas'],      fuzzyKeywords: ['idea', 'ideas', 'capture', 'note', 'thought'],            openFn: () => detectIdeaCaptureTrigger(transcript) },
    { toolName: 'Browser',  canonicalTriggers: ['open youtube', 'search google'],       fuzzyKeywords: ['open', 'browse', 'search', 'website', 'google', 'youtube'], openFn: () => detectBrowserTrigger(transcript) },
  ];
  ```

- [ ] Write `detectFuzzyToolIntent(transcript) -> { toolName, confidence } | null`:
  - Normalise `transcript` to lowercase, strip punctuation
  - For each entry in `FUZZY_TOOL_MAP`, count how many `fuzzyKeywords` appear in the normalised transcript
  - Compute `confidence = matchCount / fuzzyKeywords.length`
  - Return the highest-confidence entry if `confidence >= FUZZY_THRESHOLD` (default `0.3` — at least 30 % of keywords present); otherwise return `null`
  - Skip entries whose `canonicalTriggers` already matched via the normal intercept chain (i.e. the tool already fired — no fuzzy fallback needed)
  - Add `FUZZY_THRESHOLD` to `app.js` as a module-level constant; document in `.env.example` as a comment for visibility

**Confirmation flow (`frontend/app.js`)**

- [ ] Add a `_fuzzyConfirmPending` state variable and a `_fuzzyPendingTool` reference to track the in-flight confirmation
- [ ] In the intercept chain — after all canonical tool checks and *before* the `sendToOllama` fallback — call `detectFuzzyToolIntent(transcript)`:
  - If a match is returned: set `_fuzzyConfirmPending = true`, set `_fuzzyPendingTool` to the matched entry, speak `"Did you want to open the <toolName> tool?"` via `enqueueSpeak`, and `return` early (do not send to LLM)
  - If no match: fall through to `sendToOllama` as normal
- [ ] Add a `_fuzzyConfirmMode` check at **position 3** in the intercept chain (immediately after `journalMode` and `ideasMode` checks, before dossier exit):
  - If `_fuzzyConfirmPending` is `true`:
    - Normalise transcript; check for affirmative tokens (`yes`, `yeah`, `yep`, `correct`, `do it`, `open it`, `go ahead`, `sure`, `please`)
    - If affirmative: clear `_fuzzyConfirmPending`, call `_fuzzyPendingTool.openFn()`, speak `"Opening <toolName>."`, and `return`
    - If negative (`no`, `nope`, `cancel`, `never mind`, `stop`): clear state, speak `"Okay, never mind."`, and `return`
    - If neither (ambiguous second transcription): speak `"I didn't catch that — did you want to open <toolName>? Say yes or no."`, keep `_fuzzyConfirmPending = true`, and `return`
- [ ] Add `_clearFuzzyConfirmState()` helper — resets both flags to `false` / `null`; called from the clear button handler and from `exitPresMode()`
- [ ] Add a visible confirmation prompt to the UI: when `_fuzzyConfirmPending` is `true`, render a dismissible banner or badge (e.g. `"Did you mean: open Timer?"` with Yes / No buttons) so the user can also click to confirm or dismiss without speaking

**Intercept chain position**

Add the fuzzy confirm check to the Final Intercept Order:

```
1.  journalMode active check      ← MUST be first
2.  ideasMode active check        ← MUST be second
3.  _fuzzyConfirmMode check       ← NEW: resolve pending tool confirmation before anything else
4.  _matchesExitPhrase            ← dossier exit
    ... (existing order unchanged below)
19. detectFuzzyToolIntent         ← NEW: catch near-miss transcriptions before LLM fallback
20. appendMessage + sendToOllama  ← normal LLM path (catch-all)
```

**Edge-case guards**

- [ ] If STT returns an empty or sub-5-character transcript, skip fuzzy detection entirely — too short to be meaningful
- [ ] Add a 15-second timeout on the fuzzy confirm state: if no follow-up mic press arrives within 15 s, auto-dismiss (`_clearFuzzyConfirmState()`) and speak `"Okay, I'll cancel that."` — prevents the confirm state from silently gating all future mic presses
- [ ] When fuzzy detection fires but the user is in `journalMode` or `ideasMode`, skip fuzzy entirely — the mode flags take precedence and the utterance belongs to the active session

**`.env` additions**

```
TOOLKIT_MANIFEST_ENABLED=true
```

---

### Final Intercept Order (all tools implemented)

Once all tools are active, the intercept chain in `mediaRecorder.onstop` and `handleSend`
must follow this exact order to avoid mode flag collisions:

```
1.  journalMode active check      ← MUST be first (gates all mic presses in journal mode)
2.  ideasMode active check        ← MUST be second (gates next mic press in ideas mode)
3.  _fuzzyConfirmMode check       ← resolve pending tool confirmation before any new trigger fires
4.  _matchesExitPhrase            ← dossier exit
5.  _parseTrigger                 ← dossier open
6.  detectJournalStartTrigger     ← enter journal dictation mode
7.  detectJournalReadTrigger      ← journal read / search / delete
8.  detectIdeaCaptureTrigger      ← enter ideas capture mode
9.  detectIdeaReadTrigger         ← ideas list / search / discard / clear
10. detectTimerTrigger            ← timer set / cancel / status
11. detectTimeTrigger             ← time / date query
12. detectWeatherTrigger          ← weather forecast
13. detectCalendarTrigger         ← calendar schedule
14. detectNewsTrigger             ← news briefing
15. detectMarketTrigger           ← stocks / crypto
16. detectGmailTrigger            ← Gmail inbox / open / summarise / trash
17. detectWikiTrigger             ← Wikipedia RAG search
18. detectBrowserTrigger          ← in-UI browser panel
19. detectFuzzyToolIntent         ← catch near-miss transcriptions before falling through to LLM
20. appendMessage + sendToOllama  ← normal LLM path (catch-all)
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