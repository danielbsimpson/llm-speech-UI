# S.T.A.R.L.I.N.G. — Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator

A voice-driven, S.T.A.R.L.I.N.G.-style web interface powered by a local LLM via Ollama.

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
│   ├── stt.py          # Speech-to-text (Whisper)
│   ├── tts.py          # Text-to-speech (Kokoro / Piper)
│   └── ollama.py       # Ollama API client
├── scripts/
│   └── setup.sh        # One-shot install script
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

- [ ] Install FastAPI: `pip install fastapi uvicorn python-dotenv`
- [ ] Create `backend/main.py` with route structure
- [ ] Add `/chat` endpoint that accepts text and streams Ollama response
- [ ] Add `/transcribe` endpoint (if using Whisper)
- [ ] Add `/synthesize` endpoint (if using local TTS)
- [ ] Enable CORS for local frontend (`localhost:3000` or file://)
- [ ] Load config from `.env` (model name, API URL, etc.)
- [ ] Add basic error handling and logging

---

## Phase 7 — Streaming & Integration

- [ ] Implement streaming response from Ollama in frontend (`ReadableStream`)
- [ ] Render tokens as they arrive (typewriter effect)
- [ ] Maintain conversation history array for multi-turn context
- [ ] Pass full conversation history in each Ollama request
- [ ] Add a "clear conversation" button
- [ ] Start TTS only after full response is received (or implement sentence-chunked TTS)

---

## Phase 8 — Polish & UX

- [ ] Add loading/thinking animation while LLM is processing
- [ ] Show error messages in UI (model not found, Ollama offline, etc.)
- [ ] Add settings panel: switch models, change voice, adjust temperature
- [ ] Add conversation export (save chat to .txt or .md)
- [ ] Add auto-scroll to bottom of chat on new messages
- [ ] Optional: wake word detection ("Hey STARLING") using Web Audio API
- [ ] Optional: sound effects on mic activate / response start

---

## Phase 9 — DevEx & Tooling

- [ ] Write `scripts/setup.sh` to automate full install
- [ ] Add `Makefile` with targets: `make start`, `make backend`, `make frontend`
- [ ] Add hot-reload for frontend (e.g. Vite or live-server)
- [ ] Add hot-reload for backend (`uvicorn --reload`)
- [ ] Write basic integration test: send text → verify Ollama responds
- [ ] Document all `.env` variables in `.env.example`

---

## Stretch Goals

- [ ] Add tool use / function calling (weather, web search, calendar)
- [ ] Visualize GPU/CPU load live in the HUD
- [ ] Add multiple AI "modes" (assistant, coder, analyst) with different system prompts
- [ ] Package as an Electron desktop app for no-browser-needed launch
- [ ] Add local RAG (retrieval-augmented generation) with a document folder
- [ ] Support multiple simultaneous models / model switching on the fly

---

## Stack Summary

| Layer | Tool | Notes |
|---|---|---|
| LLM runtime | Ollama | GPU-accelerated local inference |
| LLM model | Llama 3 / Mistral / Gemma 2 | Pull via `ollama pull` |
| STT | Web Speech API or faster-whisper | Browser = easy, Whisper = accurate |
| TTS | SpeechSynthesis or Kokoro TTS | Browser = easy, Kokoro = quality |
| Backend | FastAPI + uvicorn | Optional glue, needed for Whisper/Kokoro |
| Frontend | Vanilla HTML/JS or React + Vite | Single file works fine to start |