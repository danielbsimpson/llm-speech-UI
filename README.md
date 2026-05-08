# Speech to text Local AI Interface

A voice-driven, S.T.A.R.L.I.N.G. (Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator) web interface powered entirely by a local LLM running on your GPU. No cloud APIs. No subscriptions. No Ollama wrapper. Just your hardware.

```
Microphone → Speech-to-Text → llama-server (LLM on GPU) → Text-to-Speech → Browser UI
```

![S.T.A.R.L.I.N.G. UI](assets/images/Starling_UI_example.png)

---

## Features

- 🎙 **Voice input** via browser MediaRecorder API → local faster-whisper (Whisper)
- 🧠 **Local LLM inference** directly via llama-server (llama.cpp) — no Ollama wrapper; Ollama kept as a switchable fallback
- ⚡ **Faster first-token latency** — eliminating the Ollama relay hop gives a noticeable speed improvement; generation speed visible live in the metrics bar
- 🔊 **Text-to-speech** via Kokoro TTS (local, GPU-accelerated) or browser SpeechSynthesis
- 📡 **Sentence-chunked streaming** — each sentence is synthesised and played as it arrives
- 💬 **Multi-turn conversation** with persistent context
- 🌑 **Living black sphere** — Three.js scene with 7 orbiting light orbs; reacts to audio input and shifts colour/speed per state (idle / listening / thinking / speaking)
- ⚡ **Model warm-up on load** — Kokoro and Whisper CUDA sessions are pre-heated at startup; UI shows `INITIALISING…` and GPU badges populate before the user speaks
- 📊 **LLM metrics bar** — live prompt tokens, generation speed (t/s), total time, and context window fill percentage after every response
- 🔒 **Fully local** — no data leaves your machine

---

## Requirements

- **OS:** Linux, macOS, or Windows
- **GPU:** NVIDIA GPU with 6 GB+ VRAM (CUDA 12+), or DirectX 12-capable GPU (DirectML)
- **Python:** 3.11+
- **Node.js:** 18+ (only if using the React/Vite frontend)
- **Browser:** Chrome or Edge (required for MediaRecorder / Web Speech API fallback)

### Recommended GPU / model pairings

Model files are read directly from the GGUF format. The easiest source is your existing Ollama blob cache (`%USERPROFILE%\.ollama\models\blobs\`) — no re-download needed.

| GPU VRAM | Recommended model | GGUF quant |
|---|---|---|
| 4–6 GB | Gemma 3 4B, Phi-4 Mini, Llama 3.2 3B | Q4_K_M |
| 6–8 GB | Llama 3.1 8B, Mistral 7B, Qwen 2.5 7B | Q4_K_M |
| 10–16 GB | Llama 3.1 13B, Mistral 12B | Q4_K_M |
| 40 GB+ | Llama 3.1 70B | Q4_K_M |

### Currently installed models

| Model | Size | Notes |
|---|---|---|
| `llama3.1:8b` | 4.9 GB | Strong general purpose |
| `mistral:7b` | 4.4 GB | Fast, good instruction following |
| `qwen2.5:7b` | 4.7 GB | Strong coding and reasoning |
| `gemma3:4b` | 3.3 GB | Lightweight, good for low VRAM |
| `llama3.2:3b` | 2.0 GB | **Default** — fastest response times |
| `phi4-mini` | 2.5 GB | Microsoft, strong reasoning for its size |
| `nomic-embed-text` | 274 MB | Embedding model (for future RAG) |

These are available as Ollama blobs at `%USERPROFILE%\.ollama\models\blobs\`. Point `start_llama_server.bat` at the relevant blob path or copy and rename to a `models/` directory.

---

## Project Structure

```
llm-speech-UI/
├── frontend/           # UI — HTML/CSS/JS (or React + Vite)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── backend/            # FastAPI server
│   ├── main.py
│   ├── stt.py              # Speech-to-text via faster-whisper
│   ├── tts.py              # Text-to-speech via Kokoro
│   ├── llama_server.py     # llama-server streaming relay (DEFAULT, LLM_BACKEND=llama)
│   └── ollama.py           # Ollama streaming relay (fallback, LLM_BACKEND=ollama)
├── scripts/
│   ├── setup.sh            # One-shot install script
│   └── start_llama_server.bat  # Launch llama-server on Windows (CUDA)
├── .env.example        # Environment variable template
├── requirements.txt    # Python dependencies
├── TODO.md             # Project build checklist
└── README.md
```

---

## Quickstart

### 1. Download llama-server and a model

```powershell
# Download llama-server (Windows CUDA 12) from:
# https://github.com/ggml-org/llama.cpp/releases/latest
# Extract to C:\llama.cpp\ and add to PATH

# Model files can be reused from your Ollama blob cache:
# %USERPROFILE%\.ollama\models\blobs\sha256-<hash>
# Point start_llama_server.bat at the relevant blob and run it.
```

### 2. Clone the repo

```bash
git clone https://github.com/danielbsimpson/llm-speech-UI.git
cd llm-speech-UI
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
source .venv/bin/activate  # Windows: .venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Download Kokoro model files (~330 MB)
python scripts/download_models.py

# Copy and configure environment variables
cp .env.example .env
# Edit .env — set LLM_BACKEND=llama and configure LLAMA_SERVER_URL / LLAMA_MODEL

# Start llama-server (Windows)
.\scripts\start_llama_server.bat

# In a second terminal: start the FastAPI backend (must run from backend/ directory)
cd backend
uvicorn main:app --reload --port 8000

# Open the frontend
start http://localhost:8000
```

---

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```env
# LLM backend selector
LLM_BACKEND=llama          # "llama" = llama-server (default) | "ollama" = Ollama fallback

# llama-server (LLM_BACKEND=llama)
LLAMA_SERVER_URL=http://localhost:8080
LLAMA_MODEL=llama3.2-3b    # must match --alias passed to llama-server
LLAMA_TEMPERATURE=0.7

# Ollama fallback (LLM_BACKEND=ollama)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_TEMPERATURE=0.7

# Backend
BACKEND_PORT=8000

# STT — faster-whisper
WHISPER_MODEL_SIZE=base   # tiny | base | small | medium | large-v3
WHISPER_DEVICE=cuda       # set to cpu if CUDA unavailable

# TTS — Kokoro ONNX
ONNX_PROVIDER=CUDAExecutionProvider   # or DmlExecutionProvider / CPUExecutionProvider
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
| `/chat` | POST | Send a message, stream LLM response (NDJSON) |
| `/chat/context-limit` | GET | Return the model's `n_ctx` from llama-server `/props` |
| `/transcribe` | POST | Upload audio blob, returns transcript |
| `/synthesize` | POST | Send text, returns WAV audio |
| `/synthesize/voices` | GET | List available Kokoro voices |
| `/health` | GET | Check backend status |
| `/system-status` | GET | Per-model device report (GPU/CPU/IDLE/OFFLINE) + active backend info |

### Example: stream a chat response

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the speed of light?", "history": []}'
```

---

## Troubleshooting

**llama-server not found**
Make sure `llama-server.exe` is either on your PATH or the full path is set in `scripts/start_llama_server.bat`. Download from the [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases/latest) — use the `win-cuda-12.x` build.

**Switching back to Ollama**
Set `LLM_BACKEND=ollama` in `.env` and restart the FastAPI backend. Both Ollama (`:11434`) and llama-server (`:8080`) can run simultaneously — the switch is instant.

**LLM not using my GPU**
Run `nvidia-smi` while the model is loaded. If VRAM usage is 0, check that `--n-gpu-layers` is set to a high value (999 offloads all layers) in `start_llama_server.bat`.

**Web Speech API not working**
Chrome and Edge only — Firefox does not support `webkitSpeechRecognition`. Also requires HTTPS or `localhost`.

**Model responses are slow**
Try a smaller model or increase `--n-gpu-layers`. The metrics bar shows live t/s so you can confirm GPU acceleration is active.

**Audio not playing after TTS**
Browsers enforce an autoplay policy that blocks `audio.play()` until the user has made a gesture on the page. TTS playback is triggered by the user's mic press or send button, which satisfies the policy.

---

## Roadmap

See [TODO.md](./TODO.md) for the full phased build checklist.

High-level milestones:
- [x] Project scaffolding and documentation
- [x] Ollama integration with streaming responses
- [x] **llama.cpp migration** — replaced Ollama relay with direct llama-server (OpenAI-compatible); noticeable speed gains confirmed; Ollama kept as a one-line fallback
- [x] Push-to-talk voice input (MediaRecorder → Whisper STT on GPU)
- [x] Kokoro TTS with 16 curated voices, sentence-chunked playback, and mode toggle
- [x] Living black sphere (Three.js) — 7 orbiting light orbs, audio-driven deformation, 4-state machine
- [x] Per-model GPU/CPU device reporting in footer (`/system-status`)
- [x] Model warm-up on page load — Kokoro + Whisper pre-heated, GPU badges populated before first mic press
- [x] GPU dispatch working for both Whisper (CUDA) and Kokoro (DirectML / CUDA)
- [x] LLM metrics bar — prompt tokens, generation speed, time, and context window fill percentage
- [ ] Sentence-chunked TTS latency further tuning
- [ ] Tool use / function calling
- [ ] Electron desktop app packaging
- [ ] Local RAG / GraphRAG over a documents folder

---

## Contributing

Pull requests welcome. Please open an issue first to discuss major changes. Keep PRs focused — one feature or fix per PR.

```bash
# Run the backend in dev mode (must run from backend/ directory)
cd backend && uvicorn main:app --reload --port 8000

# Lint Python
pip install ruff && ruff check backend/
```

---

## License

MIT — do whatever you want, no warranty implied.

---

> *"At your service."*