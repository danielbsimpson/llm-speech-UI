# J.A.R.V.I.S. Local AI Interface

A voice-driven, JARVIS-style web interface powered entirely by a local LLM running on your GPU. No cloud APIs. No subscriptions. Just your hardware.

```
Microphone → Speech-to-Text → Ollama (LLM on GPU) → Text-to-Speech → Browser UI
```

---

## Features

- 🎙 **Voice input** via browser Web Speech API or local Whisper
- 🧠 **Local LLM inference** via Ollama (Llama 3, Mistral, Gemma 2, and more)
- 🔊 **Text-to-speech** via browser SpeechSynthesis or Kokoro TTS
- 📡 **Streaming responses** — tokens render as they arrive
- 💬 **Multi-turn conversation** with persistent context
- 🖥 **JARVIS-style HUD** — dark interface with animated waveform and arc rings
- 🔒 **Fully local** — no data leaves your machine

---

## Requirements

- **OS:** Linux, macOS, or Windows (WSL2 recommended on Windows)
- **GPU:** NVIDIA GPU with 6 GB+ VRAM (CUDA 11.8+), or Apple Silicon (Metal)
- **Python:** 3.10+
- **Node.js:** 18+ (only if using the React/Vite frontend)
- **Browser:** Chrome or Edge (required for Web Speech API)

### Recommended GPU / model pairings

| GPU VRAM | Recommended model |
|---|---|
| 6 GB | `llama3:8b`, `mistral:7b` |
| 8 GB | `gemma2:9b`, `llama3:8b` |
| 16 GB | `llama3:13b`, `mistral:12b` |
| 40 GB+ | `llama3:70b` |

---

## Project Structure

```
jarvis-local/
├── frontend/           # UI — HTML/CSS/JS (or React + Vite)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── backend/            # FastAPI server (optional — needed for Whisper / Kokoro TTS)
│   ├── main.py
│   ├── stt.py          # Speech-to-text via faster-whisper
│   ├── tts.py          # Text-to-speech via Kokoro or Piper
│   └── ollama.py       # Ollama streaming client
├── scripts/
│   └── setup.sh        # One-shot install script
├── .env.example        # Environment variable template
├── requirements.txt    # Python dependencies
├── TODO.md             # Project build checklist
└── README.md
```

---

## Quickstart

### 1. Install Ollama and pull a model

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull your chosen model
ollama pull llama3

# Verify it's running on your GPU
ollama run llama3
# then: nvidia-smi (should show GPU memory in use)
```

### 2. Clone the repo

```bash
git clone https://github.com/yourname/jarvis-local.git
cd jarvis-local
```

### 3a. Frontend only (easiest — no Python needed)

Open `frontend/index.html` directly in Chrome. The UI talks to Ollama at `http://localhost:11434` via `fetch()`. Uses browser-native STT and TTS.

```bash
# Optional: use a local dev server for cleaner DX
npx live-server frontend/
```

### 3b. Full stack (Whisper STT + Kokoro TTS)

```bash
# Create a virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your model name, ports, etc.

# Start the backend
uvicorn backend.main:app --reload --port 8000

# Open the frontend
open frontend/index.html  # or serve it with live-server
```

---

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```env
# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3
OLLAMA_TEMPERATURE=0.7
OLLAMA_SYSTEM_PROMPT="You are JARVIS, a highly capable AI assistant. Be concise, precise, and helpful."

# Speech-to-text
STT_ENGINE=whisper          # whisper | browser
WHISPER_MODEL=base          # tiny | base | small | medium | large

# Text-to-speech
TTS_ENGINE=kokoro           # kokoro | piper | browser
TTS_VOICE=af_sarah          # Kokoro voice ID

# Backend server
BACKEND_PORT=8000
```

---

## STT Options

| Engine | Setup | Accuracy | Latency | Privacy |
|---|---|---|---|---|
| Web Speech API | Zero | Good | Fast | ⚠️ Sent to Google |
| faster-whisper | `pip install faster-whisper` | Excellent | Medium | ✅ Fully local |

To use Whisper, set `STT_ENGINE=whisper` in `.env` and ensure the FastAPI backend is running. The frontend will POST audio blobs to `/transcribe`.

---

## TTS Options

| Engine | Setup | Quality | Latency |
|---|---|---|---|
| SpeechSynthesis | Zero (browser built-in) | OK | Instant |
| Kokoro TTS | `pip install kokoro-onnx` | Excellent | Low |
| Piper TTS | Download binary + voice model | Good | Very low |

---

## API Reference (FastAPI backend)

| Endpoint | Method | Description |
|---|---|---|
| `/chat` | POST | Send a message, stream Ollama response |
| `/transcribe` | POST | Upload audio blob, returns transcript |
| `/synthesize` | POST | Send text, returns audio file |
| `/health` | GET | Check backend + Ollama status |

### Example: stream a chat response

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the speed of light?", "history": []}'
```

---

## Troubleshooting

**Ollama isn't using my GPU**
Run `nvidia-smi` while a model is loaded. If VRAM usage is 0, check that your CUDA drivers are up to date and that you installed the CUDA version of Ollama.

**Web Speech API not working**
Chrome and Edge only — Firefox does not support `webkitSpeechRecognition`. Also requires HTTPS or `localhost`.

**CORS errors in the browser**
If using the FastAPI backend, ensure CORS is enabled in `main.py` for your frontend origin. The `.env` has a `CORS_ORIGIN` variable for this.

**Model responses are slow**
Try a smaller model (`mistral:7b` is fast and capable). Also check that you're not CPU-falling-back — `ollama ps` shows which layers are on GPU vs CPU.

**Audio not playing after TTS**
Browsers block autoplay. Ensure TTS playback is triggered by a user gesture (e.g. the send button click), not programmatically on page load.

---

## Roadmap

See [TODO.md](./TODO.md) for the full phased build checklist.

High-level milestones:
- [x] Project scaffolding and documentation
- [ ] Ollama integration with streaming
- [ ] Browser STT + TTS (Phase 1 complete)
- [ ] Whisper + Kokoro local pipeline (Phase 2)
- [ ] Tool use / function calling
- [ ] Electron desktop app packaging
- [ ] Local RAG over a documents folder

---

## Contributing

Pull requests welcome. Please open an issue first to discuss major changes. Keep PRs focused — one feature or fix per PR.

```bash
# Run the backend in dev mode
uvicorn backend.main:app --reload

# Lint Python
pip install ruff && ruff check backend/
```

---

## License

MIT — do whatever you want, no warranty implied.

---

> *"At your service."*