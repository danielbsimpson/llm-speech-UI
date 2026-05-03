# JARVIS Local AI Interface — Project TODO

A voice-driven, JARVIS-style web interface powered by a local LLM via Ollama.

---

## Phase 1 — Repo Setup

- [x] Initialize repository: `git init llm-speech-ui`
- [x] Create folder structure (see below)
- [x] Add `.gitignore` (node_modules, __pycache__, .env, models/)
- [x] Add `README.md` with project overview and setup instructions
- [x] Pin Python version with `.python-version` (set to 3.11)
- [x] Add `LICENSE` file (MIT)

```
jarvis-local/
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
- [x] Optionally write a system prompt to give the AI a "JARVIS" persona

---

## Phase 3 — Speech-to-Text (STT)

### Option A — Browser Web Speech API (easiest)
- [ ] Implement `webkitSpeechRecognition` in `app.js`
- [ ] Add push-to-talk button with visual feedback
- [ ] Handle `onresult`, `onerror`, and `onend` events
- [ ] Test cross-browser compatibility (Chrome recommended)

### Option B — Local Whisper (higher accuracy)
- [ ] Install faster-whisper: `pip install faster-whisper`
- [ ] Write `backend/stt.py` with a `/transcribe` POST endpoint
- [ ] Accept audio blob from frontend (MediaRecorder API)
- [ ] Return transcript as JSON
- [ ] Choose model size: `tiny` (fast) → `base` → `small` → `medium`
- [ ] Confirm GPU acceleration is working for Whisper

---

## Phase 4 — Text-to-Speech (TTS)

### Option A — Browser SpeechSynthesis (easiest)
- [ ] Implement `SpeechSynthesisUtterance` in `app.js`
- [ ] Let user pick voice from available system voices
- [ ] Tune `rate`, `pitch`, and `volume` for a robotic JARVIS feel

### Option B — Kokoro TTS (best local quality)
- [ ] Install Kokoro: `pip install kokoro-onnx`
- [ ] Write `backend/tts.py` with a `/synthesize` POST endpoint
- [ ] Return audio as WAV/MP3, play via `<audio>` element in frontend
- [ ] Pick a voice that fits the JARVIS aesthetic

### Option C — Piper TTS (fastest, lower quality)
- [ ] Download Piper binary from GitHub releases
- [ ] Download a voice model (e.g. `en_US-ryan-high`)
- [ ] Wrap in a `/synthesize` endpoint in FastAPI

---

## Phase 5 — Frontend UI

- [ ] Build base HTML layout with the HUD aesthetic (dark bg, cyan tones)
- [ ] Add animated waveform bars (CSS + JS animation)
- [ ] Add arc reactor / ring SVG animation
- [ ] Display live streamed LLM response text (token by token)
- [ ] Show STT transcript in real time as user speaks
- [ ] Add status indicators (GPU, model name, STT/TTS engine)
- [ ] Wire mic button: start recording → STT → send to LLM → TTS
- [ ] Add text input fallback for when mic is unavailable
- [ ] Make UI responsive for different screen sizes
- [ ] Add keyboard shortcut (e.g. spacebar) to trigger mic

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
- [ ] Optional: wake word detection ("Hey JARVIS") using Web Audio API
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