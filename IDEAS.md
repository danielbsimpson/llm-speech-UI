# S.T.A.R.L.I.N.G. — Improvement Ideas

A running log of planned enhancements, each with enough detail to roll out independently.

---

## IDEA-001 — Sentence-Chunked TTS (Reduce Audio Lag) [COMPLETED✅]

**Status**: Ready to implement  
**Effort**: Small (frontend-only)  
**Impact**: First audio plays ~1–3 s after response starts instead of after it fully completes

### Problem

TTS is triggered only after the entire LLM response has streamed in:

```
stream all tokens → accumulate full string → POST /synthesize → wait for WAV → play
```

On a 5-sentence response, the user waits the full generation time **plus** synthesis time before hearing anything.

### Solution

Split the stream into sentences as tokens arrive, synthesise and play each sentence as soon as its terminal punctuation is detected, and queue subsequent sentences so they play in order without overlap.

```
token stream → sentence buffer → boundary hit → enqueue sentence → synthesise + play
                                                                   ↑ while next sentence buffers
```

---

### Implementation Plan

#### Step 1 — Add a sentence splitter

In `sendToOllama()` in `frontend/app.js`, replace the direct `full += token; txt.textContent = full` block with a buffered version:

```js
let sentBuf = '';

// inside the token loop:
sentBuf += token;
full    += token;
txt.textContent = full;

// flush complete sentences
const sentenceRe = /[^.?!]*[.?!](?:\s|$)/g;
let match;
while ((match = sentenceRe.exec(sentBuf)) !== null) {
  const sentence = match[0].trim();
  if (sentence) enqueueSpeak(sentence);
}
sentBuf = sentBuf.slice(sentenceRe.lastIndex);
```

After the stream ends, flush any remaining buffer:

```js
// after while(true) loop exits:
if (sentBuf.trim()) enqueueSpeak(sentBuf.trim());
```

**Edge cases to handle:**
- Ellipsis (`...`) — require a whitespace or end-of-string after the punctuation before treating it as a boundary
- Abbreviations (`Dr.`, `e.g.`, `vs.`) — the whitespace requirement above already skips most; extend with a small blocklist if needed
- Decimal numbers (`3.14`) — digit-before-dot check: skip boundary if the character before `.` is a digit

---

#### Step 2 — Add an audio queue

Add these helpers above `sendToOllama()`:

```js
let _audioChain = Promise.resolve();  // serial playback queue
let _activeAudio = null;              // already exists — keep as-is

function enqueueSpeak(text) {
  if (ttsMode === 'off') return;
  _audioChain = _audioChain.then(() => speak(text));
}

function clearAudioQueue() {
  // Replace the chain with a resolved promise so pending .then()s are abandoned
  _audioChain = Promise.resolve();
  if (_activeAudio) {
    _activeAudio.pause();
    _activeAudio = null;
  }
}
```

Remove the `await speak(response)` call in `handleSend()` — sentences are now spoken as they arrive. `fetchSystemStatus()` should still fire after the stream ends, not after all audio finishes.

---

#### Step 3 — Handle the state machine overlap

During chunked playback the model is still streaming while audio is playing. Two options:

- **Simple**: keep `state-thinking` for the entire stream duration, transition to `state-speaking` only once the stream ends and the queue begins draining. Feels slightly inaccurate but avoids complexity.
- **Better**: introduce a `thinking-speaking` composite: once the first sentence is enqueued, switch to `state-speaking` but keep the ring spinning (combine both CSS classes). Revert to `idle` when `_audioChain` resolves and the stream is done.

Start with the simple option; upgrade if the UX feels odd.

---

#### Step 4 — Wire interruption handling

When the user presses the mic button or sends a new message while audio is playing:

```js
// at the top of handleMicPress() and handleSend():
clearAudioQueue();
setState('idle');
```

This stops current audio and drops queued sentences so the new response can start cleanly.

---

#### Step 5 — Browser TTS fallback

`_speakBrowser()` uses the native `SpeechSynthesis` queue which handles multiple `speak()` calls natively — no change needed. The `enqueueSpeak()` helper works transparently for both modes.

---

### Files Changed

| File | Change |
|---|---|
| `frontend/app.js` | Sentence splitter in token loop; `enqueueSpeak` / `clearAudioQueue` helpers; remove post-stream `await speak(response)` |
| `backend/tts.py` | **None** — `/synthesize` already accepts any text string |
| `backend/ollama.py` | **None** |
| `backend/main.py` | **None** |

---

### Expected Result

| Metric | Before | After |
|---|---|---|
| Time to first audio | Full generation + synthesis (~5–10 s) | First sentence synthesis only (~0.5–1.5 s after it completes in stream) |
| Backend calls per response | 1 | N (one per sentence, ~3–6 for a typical response) |
| Perceived responsiveness | Response appears, long silence, then audio | Text and audio advance together |

---

## IDEA-002 — llama.cpp Migration (Remove Ollama Wrapper)

**Status**: Ready to implement  
**Effort**: Small–Medium (backend relay rewrite + one frontend line + install step)  
**Impact**: Eliminates one relay hop (FastAPI → Ollama → llama.cpp becomes FastAPI → llama.cpp), reducing time-to-first-token and removing Ollama process overhead

### Problem

Ollama is itself a wrapper around llama.cpp. The current request path is:

```
frontend → FastAPI /chat → Ollama /api/chat → llama.cpp engine
```

This means every streaming token passes through an extra process boundary. Ollama also uses its own NDJSON format that differs from the OpenAI standard, requiring custom parsing. Running llama-server directly eliminates the middle layer entirely.

### What changes, what doesn't

| Component | Change required |
|---|---|
| `backend/ollama.py` | Yes — URL, payload format, streaming format |
| `backend/main.py` | Small — `/system-status` GPU check |
| `frontend/app.js` | One line — token extraction path |
| `backend/stt.py` | **None** |
| `backend/tts.py` | **None** |
| `frontend/` HTML/CSS | **None** |
| Conversation history format | **None** — `messages[]` array is identical |
| System prompt injection | **None** — same mechanism |

---

### Pre-requisites

#### Install llama-server on Windows (CUDA)

1. Go to the [llama.cpp GitHub releases](https://github.com/ggml-org/llama.cpp/releases) page
2. Download the latest `llama-*-win-cuda-cu12.x.x-x64.zip` (match your CUDA 12.x version)
3. Extract to a permanent location, e.g. `C:\llama.cpp\`
4. Confirm the binary works: `llama-server.exe --version`

#### Locate existing model files

Ollama stores its GGUF files in `%LOCALAPPDATA%\Ollama\models\blobs\`. They are valid GGUF files with hashed names. Either:
- Copy and rename them to a `models/` directory (e.g. `llama3.1-8b-Q4_K_M.gguf`), or
- Download fresh GGUF files from Hugging Face (llama-server can do this directly via `--hf-repo`)

---

### Implementation Plan

#### Step 1 — Rewrite `backend/ollama.py`

Replace the Ollama-specific relay with an OpenAI-compatible one targeting llama-server.

**Key differences:**
- URL: `http://localhost:11434/api/chat` → `http://localhost:8080/v1/chat/completions`
- Payload: Ollama uses `{"options": {"temperature": N}}` → OpenAI uses top-level `"temperature": N`
- Streaming format: Ollama NDJSON `{"message":{"content":"token"}}` → OpenAI SSE `data: {"choices":[{"delta":{"content":"token"}}]}`
- Media type: `application/x-ndjson` → `text/event-stream`

New `ollama.py` (rename to `llama_server.py` or keep name for minimal diff):

```python
"""backend/ollama.py — Streaming chat relay to llama-server (OpenAI-compatible)."""

import os
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/chat", tags=["llama"])

LLAMA_BASE    = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")
DEFAULT_MODEL = os.getenv("LLAMA_MODEL", "llama3.1-8b")
SYSTEM_PROMPT = os.getenv(
    "LLAMA_SYSTEM_PROMPT",
    "You are S.T.A.R.L.I.N.G. ...",
)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = DEFAULT_MODEL
    temperature: float = float(os.getenv("LLAMA_TEMPERATURE", "0.7"))


async def _stream_llama(payload: dict):
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{LLAMA_BASE}/v1/chat/completions", json=payload
        ) as resp:
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="llama-server error")
            async for chunk in resp.aiter_bytes():
                yield chunk


@router.post("/")
async def chat(req: ChatRequest):
    messages = [m.model_dump() for m in req.messages]
    if not messages or messages[0].get("role") != "system":
        messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    payload = {
        "model":       req.model,
        "messages":    messages,
        "temperature": req.temperature,
        "stream":      True,
    }
    return StreamingResponse(_stream_llama(payload), media_type="text/event-stream")
```

---

#### Step 2 — Update token parsing in `frontend/app.js`

Find the single line in `sendToOllama()` that extracts the token from each streamed line:

```js
// BEFORE (Ollama NDJSON):
const token = JSON.parse(line)?.message?.content ?? '';

// AFTER (OpenAI SSE):
const token = JSON.parse(line.replace(/^data:\s*/, ''))?.choices?.[0]?.delta?.content ?? '';
```

Also update the stream-end detection — Ollama sends `{"done":true}`, OpenAI SSE sends `data: [DONE]`. Add a guard:

```js
if (line.trim() === 'data: [DONE]') break;  // add before the JSON.parse
```

Remove the `OLLAMA_BASE` constant at the top of `app.js` — it is unused once the direct Ollama reference is gone.

---

#### Step 3 — Update `/system-status` in `backend/main.py`

The current GPU check calls `OLLAMA_BASE/api/ps` (Ollama-specific). Replace with a call to llama-server's `/slots` endpoint:

```python
# BEFORE — Ollama /api/ps
resp = await client.get(f"{OLLAMA_BASE}/api/ps")
models = resp.json().get("models", [])
size_vram = sum(m.get("size_vram", 0) for m in models)
ollama_device = "GPU" if size_vram > 0 else "CPU"

# AFTER — llama-server /slots
resp = await client.get(f"{LLAMA_BASE}/slots")
slots = resp.json()  # list of slot objects
# A loaded slot with is_processing or n_ctx > 0 means model is active
llama_device = "GPU"   # llama-server on CUDA always runs on GPU when loaded
# For a more precise check, query /props for build_info or /metrics
```

> Note: llama-server doesn't expose a VRAM-usage field the way Ollama does. The simplest approach is to treat a successful `/health` response as `GPU` when the server was started with `--n-gpu-layers all`. For a more precise check, parse the `timings` field from a test completion or read `GET /metrics`.

Update the import and env var references: `OLLAMA_BASE` → `LLAMA_BASE`, imported from `llama_server` (or wherever you renamed the module).

---

#### Step 4 — Update `.env` and `.env.example`

```ini
# BEFORE
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
OLLAMA_TEMPERATURE=0.7
OLLAMA_SYSTEM_PROMPT=...

# AFTER
LLAMA_SERVER_URL=http://localhost:8080
LLAMA_MODEL=llama3.1-8b         # matches the --alias you give llama-server
LLAMA_TEMPERATURE=0.7
LLAMA_SYSTEM_PROMPT=...
```

---

#### Step 5 — Launch llama-server

**Single model:**
```bat
llama-server.exe -m C:\models\llama3.1-8b-Q4_K_M.gguf --alias llama3.1-8b --n-gpu-layers all --port 8080 --host 127.0.0.1
```

**Multiple models (router mode):**
```bat
llama-server.exe --models-dir C:\models\ --n-gpu-layers all --port 8080 --host 127.0.0.1
```
In router mode, each `.gguf` in the directory is available by filename (without extension) as the `"model"` field. The `--alias` set per model in a preset `.ini` can make names cleaner.

Add a `scripts/start_llama_server.bat` helper for convenience.

---

### Multiple model support

llama-server's router mode handles this natively — no code changes required. Routing is done by the `"model"` field in the request body, exactly as Ollama does today. Per-model GPU layers, context size, and chat template can be configured via a `--models-preset models.ini` file.

---

### Files Changed

| File | Change |
|---|---|
| `backend/ollama.py` | Full rewrite — OpenAI-compatible payload and SSE streaming |
| `backend/main.py` | `/system-status` GPU check: swap Ollama `/api/ps` for llama-server `/slots` or `/health` |
| `frontend/app.js` | Token extraction path (1 line); add `data: [DONE]` guard; remove `OLLAMA_BASE` constant |
| `.env` / `.env.example` | Rename env vars (`OLLAMA_*` → `LLAMA_*`) |
| `scripts/` | Add optional `start_llama_server.bat` launch helper |
| `backend/stt.py` | **None** |
| `backend/tts.py` | **None** |
| `frontend/` HTML/CSS | **None** |

---

### Rollback plan

Both Ollama (port 11434) and llama-server (port 8080) can run simultaneously. Keep the old `ollama.py` as `ollama_legacy.py` during the transition and swap `main.py`'s router import to revert instantly.

---

### Expected Result

| Metric | Before | After |
|---|---|---|
| Relay hops | 3 (frontend → FastAPI → Ollama → llama.cpp) | 2 (frontend → FastAPI → llama.cpp) |
| Time to first token | Ollama relay adds ~20–80 ms per request | Eliminated |
| API format | Custom Ollama NDJSON | Standard OpenAI SSE (compatible with more tooling) |
| Model management | `ollama pull` + Ollama daemon | Raw GGUF files, no daemon required |
| Multiple models | Ollama handles transparently | llama-server router mode handles transparently |

---

## IDEA-003 — Contextual Image Display (RAG)

**Status**: Ready to implement (Phase 0 → Phase 1 sequence — see below)  
**Effort**: Phase 0: Small (frontend-only) · Phase 1: Medium (backend + prompt engineering)  
**Impact**: Phase 0 establishes voice-triggered layout foundation with no backend dependency. Phase 1 populates it with real images from a local manifest.

---

### Phase 0 — Voice-Triggered Dossier Shell

**Status**: Implement first — required foundation for Phase 1 and IDEA-004  
**Effort**: Small (frontend-only, no backend changes)  
**Impact**: When the user says a dossier trigger phrase, the chat window dims and a reserved placeholder region appears — establishing the layout shell that Phase 1 will fill with images and IDEA-004 will expand into full presentation mode. No data is fetched; the LLM is not involved in the trigger decision.

#### What this phase does

Client-side string matching is applied to the STT transcript immediately after transcription, before `sendToOllama()` is called. If a known trigger phrase is detected the UI shifts into `.dossier-mode` and the transcript is swallowed — no LLM round-trip occurs. An exit phrase (or a button, added in IDEA-004) reverts the layout.

```
user speaks "show me the dossier"
  → STT transcribes
  → _matchesPhraseList() intercepts before Ollama call
  → enterDossierMode() — .starling gains .dossier-mode
  → .dossier-shell slides in (top-right placeholder)
  → .chat-panel dims
  → no Ollama call, no audio response
  → (Phase 1 will populate .dossier-shell with an image here)
```

#### Trigger phrase lists

Matching is case-insensitive and uses `String.includes` — the phrase just needs to appear anywhere in the transcript.

```js
const DOSSIER_TRIGGERS = [
  'show me the dossier',
  'can i see the dossier',
  'what does the dossier look like',
  'open the dossier',
  'pull up the dossier',
  'bring up the dossier',
  'display the dossier',
];

const DOSSIER_EXIT_PHRASES = [
  'go back',
  'close the dossier',
  'close dossier',
  'exit dossier',
  'back to chat',
  'resume chat'
];
```

Exit phrases are checked **before** triggers so `"close the dossier"` never accidentally matches a trigger.

#### HTML changes (`frontend/index.html`)

Add a `.dossier-shell` sibling inside the flex row that IDEA-004 Step 1 will fully restructure. For Phase 0, it is a styled placeholder:

```html
<!-- Add immediately before the existing .chat-panel -->
<div class="dossier-shell" id="dossier-shell">
  <div class="dossier-placeholder">
    <span class="dossier-placeholder-label">DOSSIER</span>
  </div>
</div>
```

Phase 1 (below) replaces the inner `.dossier-placeholder` content with an `<img>` and caption. IDEA-004 Step 1 absorbs this element into the `.body-row` restructure.

#### CSS changes (`frontend/style.css`)

```css
/* ── Dossier shell ───────────────────────────────────────────────────────── */
.dossier-shell {
  width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  flex-shrink: 0;
  transition: width 0.5s ease, opacity 0.5s ease;
}

.starling.dossier-mode .dossier-shell {
  width: 280px;
  min-width: 280px;
  opacity: 1;
}

.dossier-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  border: 1px dashed rgba(200,200,200,0.12);
  border-radius: 4px;
  margin: 16px 16px 0 0;
}

.dossier-placeholder-label {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.65rem;
  letter-spacing: 0.25em;
  color: rgba(200,200,200,0.2);
  text-transform: uppercase;
}

/* Chat dims (not fully hidden) in Phase 0 — full collapse comes in IDEA-004 */
.starling.dossier-mode .chat-panel {
  opacity: 0.3;
  transition: opacity 0.4s ease;
}
```

#### JS changes (`frontend/app.js`)

**Add constants and helpers (near the top, after `MODEL` declaration):**

```js
const DOSSIER_TRIGGERS = [
  'show me the dossier', 'can i see the dossier', 'what does the dossier look like',
  'open the dossier', 'pull up the dossier', 'bring up the dossier', 'display the dossier',
];

const DOSSIER_EXIT_PHRASES = [
  'go back', 'close the dossier', 'close dossier', 'exit dossier', 'back to chat', 'resume chat',
];

function _matchesPhraseList(text, list) {
  const lower = text.toLowerCase();
  return list.some(p => lower.includes(p));
}

function enterDossierMode() {
  document.querySelector('.starling').classList.add('dossier-mode');
}

function exitDossierMode() {
  document.querySelector('.starling').classList.remove('dossier-mode');
}
```

**Hook into the STT result handler, before `sendToOllama(transcript)` is called:**

```js
// Check exit phrases first, then triggers — order matters
if (_matchesPhraseList(transcript, DOSSIER_EXIT_PHRASES)) {
  exitDossierMode();
  setState('idle');
  return;   // swallow transcript — no Ollama call
}
if (_matchesPhraseList(transcript, DOSSIER_TRIGGERS)) {
  enterDossierMode();
  setState('idle');
  return;   // swallow transcript — pure layout command
}
```

**Wire `exitDossierMode()` into the clear button handler:**

```js
clearBtn.addEventListener('click', () => {
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatInner.innerHTML = '';
  exitDossierMode();   // add this line
  setState('idle');
});
```

#### Files changed (Phase 0 only)

| File | Change |
|---|---|
| `frontend/index.html` | Add `.dossier-shell` with `.dossier-placeholder` before `.chat-panel` |
| `frontend/style.css` | Add `.dossier-shell`, `.dossier-placeholder`, `.dossier-placeholder-label`, `.dossier-mode` overrides |
| `frontend/app.js` | `DOSSIER_TRIGGERS`, `DOSSIER_EXIT_PHRASES`, `_matchesPhraseList`, `enterDossierMode`, `exitDossierMode`; STT result intercept; clear-btn wiring |
| `backend/*` | **None** |

#### Progression path

| Phase | What's added | Depends on |
|---|---|---|
| **0 (this)** | Trigger phrases → `.dossier-mode` CSS class → placeholder shell | Nothing |
| **1 (Phase 1 below)** | Manifest + backend + real image populates the shell | Phase 0 HTML structure |
| **2 (IDEA-004)** | Full presentation mode — chat collapses fully, pres-output, ring shift | Phase 0 + Phase 1 |

---

### Phase 1 — Manifest + Image Display (RAG)

### Problem

STARLING is purely audio/text. When a user asks "Tell me about Apollo 13" or "Who is Richard Feynman?", there is no visual component — the user only hears and reads a response. A curated local image library could be surfaced automatically to accompany relevant answers.

### Solution

Three components working together:

1. **Trigger tag** — the system prompt instructs STARLING to prepend `[IMAGE:key]` to responses about subjects that have an image in the manifest. The frontend strips the tag before displaying text.
2. **Local manifest** — `assets/images/manifest.json` is the single source of truth for which images exist. The backend exposes it via `/rag/manifest` and resolves keys to files via `/rag/image/{key}`.
3. **Image panel** — a new UI region to the left of the chat box (flex row) displays the image with a caption, fades in on trigger, and clears on conversation reset.

```
user asks about X
  → LLM prepends [IMAGE:apollo_13] to response
  → app.js strips tag, calls triggerImage("apollo_13")
  → GET /rag/image/apollo_13 → streams file from assets/images/
  → .image-panel fades in with image + caption
  → STARLING narrates while image is displayed
```

---

### Pre-requisites

- Populate `assets/images/` with your curated image library (JPG/PNG/WebP)
- The manifest key vocabulary should be injected into the system prompt at startup — load `GET /rag/manifest` in `app.js` init and append the key list to `SYSTEM_PROMPT` before the first message

---

### Implementation Plan

#### Step 1 — Create the image manifest

Create `assets/images/manifest.json`:

```json
[
  { "key": "apollo_13",       "label": "Apollo 13",        "file": "apollo_13.jpg",       "tags": ["nasa", "space", "mission"] },
  { "key": "richard_feynman", "label": "Richard Feynman",  "file": "richard_feynman.jpg", "tags": ["physics", "person"] },
  { "key": "turing_machine",  "label": "Turing Machine",   "file": "turing_machine.png",  "tags": ["computer science", "alan turing"] }
]
```

Schema: each entry must have `key` (lowercase_underscore, unique), `label` (display name), `file` (filename relative to `assets/images/`), `tags` (optional, for future filtering).

---

#### Step 2 — Create `backend/rag.py`

New FastAPI router with two endpoints:

```python
"""backend/rag.py — Local image RAG router."""

import json
import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/rag", tags=["rag"])

ASSETS_DIR = Path(__file__).parent.parent / "assets" / "images"
MANIFEST_PATH = ASSETS_DIR / "manifest.json"


def _load_manifest() -> list[dict]:
    if not MANIFEST_PATH.exists():
        return []
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        return json.load(f)


@router.get("/manifest")
def get_manifest():
    """Return the full image manifest."""
    return _load_manifest()


@router.get("/image/{key}")
def get_image(key: str):
    """Resolve a manifest key to an image file and stream it."""
    manifest = _load_manifest()
    entry = next((e for e in manifest if e["key"] == key), None)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"No image for key '{key}'")
    image_path = ASSETS_DIR / entry["file"]
    if not image_path.exists():
        raise HTTPException(status_code=404, detail=f"Image file not found: {entry['file']}")
    # Prevent path traversal — ensure resolved path stays within ASSETS_DIR
    if not image_path.resolve().is_relative_to(ASSETS_DIR.resolve()):
        raise HTTPException(status_code=400, detail="Invalid path")
    media_type = mimetypes.guess_type(str(image_path))[0] or "application/octet-stream"
    return FileResponse(str(image_path), media_type=media_type)
```

---

#### Step 3 — Register the router in `backend/main.py`

```python
# Add alongside existing router imports:
from rag import router as rag_router

# Add alongside existing include_router calls:
app.include_router(rag_router)
```

---

#### Step 4 — Add `.image-panel` to `frontend/index.html`

Wrap the existing `.chat-panel` and a new `.image-panel` in a shared flex row container, inserted between the ring section and the controls:

```html
<!-- Replace the standalone <div class="chat-panel"> with this block: -->
<div class="content-row">

  <!-- Image panel — hidden until a trigger fires -->
  <div class="image-panel" id="image-panel">
    <img class="image-display" id="image-display" alt="" />
    <div class="image-caption" id="image-caption"></div>
  </div>

  <!-- Chat -->
  <div class="chat-panel">
    <div class="chat-inner" id="chat-inner"></div>
  </div>

</div>
```

---

#### Step 5 — Add image panel styles to `frontend/style.css`

```css
/* ── Content row (image panel + chat side-by-side) ───────────────────────── */
.content-row {
  display: flex;
  flex-direction: row;
  flex: 1;
  gap: 16px;
  min-height: 0;          /* allow children to shrink inside flex column */
  overflow: hidden;
}

/* ── Image panel ─────────────────────────────────────────────────────────── */
.image-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: width 0.4s ease, opacity 0.4s ease, min-width 0.4s ease;
  flex-shrink: 0;
}

.image-panel.visible {
  width: 260px;
  min-width: 260px;
  opacity: 1;
}

.image-display {
  width: 100%;
  max-height: 220px;
  object-fit: contain;
  border: 1px solid rgba(200,200,200,0.1);
  border-radius: 4px;
  background: rgba(255,255,255,0.02);
}

.image-caption {
  margin-top: 8px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.68rem;
  color: rgba(200,200,200,0.5);
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

Remove the standalone `flex: 1` from `.chat-panel` if it was set there (the `content-row` flex layout now controls sizing) and ensure `.chat-panel` keeps `flex: 1; min-width: 0` so it fills remaining space:

```css
.chat-panel {
  flex: 1;
  min-width: 0;
  /* all other existing properties unchanged */
}
```

---

#### Step 6 — Add `triggerImage` / `clearImage` and manifest loading to `frontend/app.js`

**6a — Load the manifest at startup and inject keys into system prompt:**

```js
// Replace the static SYSTEM_PROMPT declaration with a two-phase init:
let SYSTEM_PROMPT =
  'You are S.T.A.R.L.I.N.G. (Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator), ' +
  'a highly capable local AI assistant. Be concise, precise, and direct. Avoid unnecessary pleasantries.';

async function loadManifestAndPrimePrompt() {
  try {
    const res = await fetch(`${BACKEND_BASE}/rag/manifest`);
    if (!res.ok) return;
    const manifest = await res.json();
    if (!manifest.length) return;
    const keyList = manifest.map(e => `  • ${e.key} — ${e.label}`).join('\n');
    SYSTEM_PROMPT +=
      '\n\nYou have access to a local image library. If your response is primarily about one of the ' +
      'following subjects, prepend your entire response with [IMAGE:key] on its own line (no other text ' +
      'before it), where key is taken exactly from this list. Only use keys from this list — never invent one.\n' +
      keyList;
    // Update the system message already in conversationHistory
    conversationHistory[0].content = SYSTEM_PROMPT;
  } catch { /* manifest unavailable — proceed without image support */ }
}
```

Call `loadManifestAndPrimePrompt()` in the init block at the bottom of `app.js` alongside `loadVoices()`.

**6b — Add DOM refs for the image panel:**

```js
const imagePanel   = document.getElementById('image-panel');
const imageDisplay = document.getElementById('image-display');
const imageCaption = document.getElementById('image-caption');
```

**6c — Add `triggerImage` and `clearImage` helpers:**

```js
async function triggerImage(key) {
  try {
    // Validate key exists by fetching the manifest entry (lightweight)
    const manifestRes = await fetch(`${BACKEND_BASE}/rag/manifest`);
    if (!manifestRes.ok) return;
    const manifest = await manifestRes.json();
    const entry = manifest.find(e => e.key === key);
    if (!entry) return;                           // unknown key — silently ignore

    imageDisplay.src     = `${BACKEND_BASE}/rag/image/${encodeURIComponent(key)}`;
    imageCaption.textContent = entry.label.toUpperCase();
    imagePanel.classList.add('visible');
  } catch { /* ignore — image display is non-critical */ }
}

function clearImage() {
  imagePanel.classList.remove('visible');
  // Delay src clear until after the CSS transition finishes
  setTimeout(() => {
    imageDisplay.src     = '';
    imageCaption.textContent = '';
  }, 450);
}
```

**6d — Parse `[IMAGE:key]` tag in the token loop inside `sendToOllama()`:**

The tag will appear as the first token(s) of the response. Buffer the opening characters until the closing `]` is confirmed, then extract and strip:

```js
let imageTagBuf = '';     // accumulates prefix until tag is resolved
let imageTagDone = false; // true once the opening of the response is confirmed

// Inside the token loop, replace the token accumulation block:
full    += token;
txt.textContent = full;

if (!imageTagDone) {
  imageTagBuf += token;
  // Wait until we have enough content to either confirm or rule out a tag
  if (imageTagBuf.includes(']') || imageTagBuf.length > 40) {
    const tagMatch = imageTagBuf.match(/^\[IMAGE:([a-z0-9_]+)\]\n?/);
    if (tagMatch) {
      const key = tagMatch[1];
      // Strip the tag from displayed text
      full = full.replace(tagMatch[0], '');
      txt.textContent = full;
      triggerImage(key);   // fire-and-forget — non-blocking
    }
    imageTagDone = true;
  }
}
```

**6e — Wire `clearImage()` into the clear button handler:**

```js
clearBtn.addEventListener('click', () => {
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatInner.innerHTML = '';
  clearImage();
  setState('idle');
});
```

---

### Files Changed

| File | Change |
|---|---|
| `assets/images/manifest.json` | Create — image manifest schema |
| `backend/rag.py` | Create — `/rag/manifest` and `/rag/image/{key}` endpoints |
| `backend/main.py` | Add `from rag import router as rag_router` + `app.include_router(rag_router)` |
| `frontend/index.html` | Wrap chat panel in `.content-row`; add `.image-panel` sibling |
| `frontend/style.css` | Add `.content-row`, `.image-panel`, `.image-display`, `.image-caption` styles |
| `frontend/app.js` | Manifest load + prompt injection; `triggerImage` / `clearImage`; tag parser in token loop; clear-btn wiring |
| `backend/stt.py` | **None** |
| `backend/tts.py` | **None** |

---

### Verification Checklist

1. Add 2–3 test images to `assets/images/` and populate `manifest.json`
2. Ask "Tell me about [subject]" — confirm `[IMAGE:key]` tag is stripped from displayed text, image panel slides in, caption appears
3. Ask about a topic with no matching key — confirm panel stays hidden and no console errors
4. Ask a follow-up on a different subject — confirm image updates to the new one
5. Press the clear button — confirm image panel fades out
6. Hit `GET /rag/image/nonexistent_key` directly — confirm 404 response with no server crash
7. Remove a file from `assets/images/` while keeping its manifest entry — confirm 404 returned gracefully

---

### Design Decisions to Confirm Before Implementing

| Decision | Options | Recommendation |
|---|---|---|
| Panel layout | Side-by-side (left) vs. full-width strip above chat | Side-by-side — matches user description; better on widescreen |
| Image panel width | Fixed (260 px) vs. percentage (25%) | Fixed — predictable at all viewport widths |
| Key injection | Static in prompt vs. dynamic load at startup | Dynamic (`loadManifestAndPrimePrompt`) — manifest stays as single source of truth |
| Auto-clear on new message | Yes vs. keep until replaced | Keep until replaced — less distracting; new query will overwrite naturally |
| Multi-image per response | First tag only vs. gallery | First tag only for v1 |

---

### Scope Boundaries

- Local curated images only — no web search, no scraping
- No image generation (Stable Diffusion etc.)
- No video or GIF support in v1
- "RAG" = key-lookup against a local JSON manifest, not vector embeddings — intentionally lightweight

---

### Expected Result

| Scenario | Before | After |
|---|---|---|
| "Tell me about Apollo 13" | Text + audio only | Image appears left of chat; STARLING narrates |
| Topic with no image | Text + audio | No change — panel stays hidden |
| Clear conversation | Chat wipes | Chat wipes + image panel fades out |
| Unknown key hallucinated by LLM | N/A | 404 swallowed silently; no panel shown |

---

## IDEA-004 — Dynamic Presentation Mode (Context-Driven Layout Shift)

**Status**: Ready to implement (depends on IDEA-003 Phase 0 HTML structure + Phase 1 image infrastructure)  
**Effort**: Medium (CSS transitions + ~100 lines across 3 files)  
**Impact**: When STARLING answers a topic with a contextual image, the entire UI reconfigures — image slides in from the left, ring shifts right, chat collapses, and STARLING's output streams below the ring in a clean focused view. A button or voice command reverts to conversation mode.

### Problem

IDEA-003 adds an image panel beside the chat box, but both regions compete for space and the overall feel is still a "chat with an image attachment". For topics that warrant a visual — a person, place, mission, concept — a more dramatic layout shift turns STARLING into a presentation system: image on the left, voice and text output on the right, conversational history hidden until needed.

### Solution

A single CSS class `.presentation-mode` added to `.starling` drives every transition via pre-defined CSS rules. No DOM manipulation at runtime — elements only change `width`, `opacity`, `max-height`, and `flex` values, all of which CSS can interpolate smoothly. A mirrored text element (`#pres-output`) below the ring shows the streaming response while the chat bubble accumulates silently in the background.

```
[IMAGE:key] tag fires
  → enterPresentationMode(key)
      → .starling gains .presentation-mode
      → .image-panel slides in (width 0 → 45%)
      → .ring-section shifts right (centred in now-narrower .main-col)
      → .chat-panel collapses (opacity → 0, max-height → 0)
      → #pres-output expands below ring
  → token loop mirrors text to both .msg.asst and #pres-output
  → STARLING speaks while image is displayed

user says "go back" / clicks EXIT button
  → exitPresentationMode()
      → .presentation-mode removed
      → all transitions reverse
      → chat history reappears intact
```

---

### Pre-requisites

- IDEA-003 Phase 0 must be implemented first — this idea reuses the `.dossier-mode`/`.dossier-shell` structure, `enterDossierMode`/`exitDossierMode` helpers, and the `_matchesPhraseList` intercept
- IDEA-003 Phase 1 provides the manifest and `[IMAGE:key]` trigger tag that populates the panel
- The HTML restructuring in this idea supersedes IDEA-003 Phase 0's placeholder element; implement IDEA-004 Step 1 and the placeholder is replaced in one pass

---

### Implementation Plan

#### Step 1 — Restructure `frontend/index.html`

Replace the standalone `.chat-panel` block (and any IDEA-003 `.content-row` if already added) with a new `.body-row` / `.main-col` structure:

```html
<!-- Replaces everything between the ring-section and controls divs -->
<div class="body-row">

  <!-- Image panel — hidden until a trigger fires -->
  <div class="image-panel" id="image-panel">
    <img class="image-display" id="image-display" alt="" />
    <div class="image-caption" id="image-caption"></div>
    <button class="pres-exit-btn" id="pres-exit-btn" title="Return to conversation">EXIT ✕</button>
  </div>

  <!-- Main column — contains ring + chat + presentation output -->
  <div class="main-col">

    <!-- Ring + waveform (already exists — move inside .main-col) -->
    <div class="ring-section">
      <!-- existing ring-wrap and waveform contents unchanged -->
    </div>

    <!-- Presentation output — visible only in presentation mode -->
    <div class="pres-output" id="pres-output"></div>

    <!-- Chat — visible only in conversation mode -->
    <div class="chat-panel">
      <div class="chat-inner" id="chat-inner"></div>
    </div>

  </div>
</div>
```

> Note: the existing `.ring-section` HTML is moved inside `.main-col` — its internal contents are unchanged.

---

#### Step 2 — Add layout and mode styles to `frontend/style.css`

**Body row and main column:**

```css
/* ── Body row (image panel + main column side-by-side) ───────────────────── */
.body-row {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  gap: 0;
}

.main-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: padding-left 0.5s ease;
}
```

**Image panel (replaces IDEA-003 Step 5 version — updated for presentation mode):**

```css
/* ── Image panel ─────────────────────────────────────────────────────────── */
.image-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  flex-shrink: 0;
  padding-top: 0;
  transition: width 0.5s ease, opacity 0.5s ease, padding 0.5s ease;
  position: relative;
}

.starling.presentation-mode .image-panel {
  width: 45%;
  min-width: 240px;
  opacity: 1;
  padding-top: 16px;
  padding-right: 20px;
}

.image-display {
  width: 100%;
  max-height: 55vh;
  object-fit: contain;
  border: 1px solid rgba(200,200,200,0.1);
  border-radius: 4px;
  background: rgba(255,255,255,0.02);
}

.image-caption {
  margin-top: 10px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.68rem;
  color: rgba(200,200,200,0.5);
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

/* Exit button inside image panel */
.pres-exit-btn {
  display: none;
  margin-top: 18px;
  padding: 6px 16px;
  background: rgba(200,200,200,0.04);
  border: 0.5px solid rgba(200,200,200,0.18);
  border-radius: 5px;
  color: rgba(200,200,200,0.45);
  font-family: 'Share Tech Mono', monospace;
  font-size: 9px;
  letter-spacing: 2px;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background 0.2s;
}
.pres-exit-btn:hover {
  color: var(--c);
  border-color: rgba(200,200,200,0.35);
  background: rgba(200,200,200,0.08);
}
.starling.presentation-mode .pres-exit-btn {
  display: block;
}
```

**Chat panel — collapses in presentation mode:**

```css
/* Extend the existing .chat-panel rule: */
.chat-panel {
  transition: opacity 0.4s ease, max-height 0.5s ease, margin 0.4s ease;
  max-height: 9999px;   /* large enough to never clip in conversation mode */
}

.starling.presentation-mode .chat-panel {
  opacity: 0;
  max-height: 0;
  margin-bottom: 0;
  pointer-events: none;
  overflow: hidden;
}
```

**Presentation output — expands below ring in presentation mode:**

```css
/* ── Presentation output ─────────────────────────────────────────────────── */
.pres-output {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  font-size: 15px;
  line-height: 1.75;
  color: var(--text);
  padding: 0 14px;
  transition: opacity 0.4s ease 0.25s, max-height 0.5s ease;
}

.starling.presentation-mode .pres-output {
  max-height: 40vh;
  opacity: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

.pres-output::-webkit-scrollbar { width: 3px; }
.pres-output::-webkit-scrollbar-track { background: transparent; }
.pres-output::-webkit-scrollbar-thumb { background: rgba(200,200,200,0.1); border-radius: 2px; }
```

**Ring section — reduce bottom margin in presentation mode so output sits closer:**

```css
.starling.presentation-mode .ring-section {
  margin-bottom: 4px;
}
```

**Waveform — optionally hide in presentation mode (set to taste):**

```css
.starling.presentation-mode .waveform {
  opacity: 0.35;   /* dim rather than hide — keeps audio activity visible */
}
```

---

#### Step 3 — Add mode functions to `frontend/app.js`

**3a — New DOM refs:**

```js
const presOutput  = document.getElementById('pres-output');
const presExitBtn = document.getElementById('pres-exit-btn');
```

**3b — Mode toggle functions:**

```js
let _inPresentationMode = false;

function enterPresentationMode() {
  _inPresentationMode = true;
  starlingEl.classList.add('presentation-mode');
  presOutput.textContent = '';
}

function exitPresentationMode() {
  _inPresentationMode = false;
  starlingEl.classList.remove('presentation-mode');
  presOutput.textContent = '';
}
```

**3c — Exit button listener:**

```js
presExitBtn.addEventListener('click', exitPresentationMode);
```

**3d — Keyword intercept (voice/text revert):**

Add at the top of `handleSend()`, before the `sendToOllama()` call, and also at the top of the `mediaRecorder.onstop` handler, before the `sendToOllama()` call:

```js
const REVERT_PHRASES = ['go back', 'exit', 'show chat', 'conversation mode', 'close image', 'hide image'];
if (_inPresentationMode && REVERT_PHRASES.some(p => text.toLowerCase().includes(p))) {
  exitPresentationMode();
  return;   // do not forward to LLM
}
```

**3e — Enter presentation mode from the image trigger:**

In the existing `triggerImage(key)` function (from IDEA-003), add `enterPresentationMode()` before setting the image src:

```js
async function triggerImage(key) {
  try {
    const manifestRes = await fetch(`${BACKEND_BASE}/rag/manifest`);
    if (!manifestRes.ok) return;
    const manifest = await manifestRes.json();
    const entry = manifest.find(e => e.key === key);
    if (!entry) return;

    enterPresentationMode();   // ← add this line

    imageDisplay.src         = `${BACKEND_BASE}/rag/image/${encodeURIComponent(key)}`;
    imageCaption.textContent = entry.label.toUpperCase();
    imagePanel.classList.add('visible');
  } catch { }
}
```

**3f — Mirror streaming text to `#pres-output` in the token loop:**

Inside `sendToOllama()`, immediately after `txt.textContent = full;`, add:

```js
if (_inPresentationMode) {
  presOutput.textContent = full;
  presOutput.scrollTop   = presOutput.scrollHeight;
}
```

**3g — Clear presentation state on conversation clear:**

In the `clearBtn` event listener, add `exitPresentationMode()` alongside `clearImage()`:

```js
clearBtn.addEventListener('click', () => {
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatInner.innerHTML = '';
  clearImage();
  exitPresentationMode();
  setState('idle');
});
```

---

### Files Changed

| File | Change |
|---|---|
| `frontend/index.html` | Wrap ring + chat in `.body-row` / `.main-col`; add `.image-panel`; add `.pres-output`; add `.pres-exit-btn` |
| `frontend/style.css` | Add `.body-row`, `.main-col`, `.pres-output`, `.pres-exit-btn`; add `.presentation-mode` overrides for chat-panel, ring-section, waveform, image-panel |
| `frontend/app.js` | `enterPresentationMode` / `exitPresentationMode`; DOM refs; exit-btn listener; keyword intercept in send/mic handlers; text mirror in token loop; clear-btn wiring |
| `assets/images/manifest.json` | Create (shared with IDEA-003) |
| `backend/rag.py` | Create (shared with IDEA-003) |
| `backend/main.py` | Add RAG router (shared with IDEA-003) |
| `backend/stt.py` | **None** |
| `backend/tts.py` | **None** |

---

### Relationship to IDEA-003

IDEA-003 and IDEA-004 share backend infrastructure (manifest, `/rag/` endpoints) and the `[IMAGE:key]` trigger tag. The HTML restructuring in IDEA-004 Step 1 replaces IDEA-003 Step 4 — implement IDEA-004's version and IDEA-003 is automatically covered. Implementing IDEA-003 first and then IDEA-004 on top is also valid; IDEA-004 Step 1 is the only step that needs merging.

---

### Design Decisions to Confirm Before Implementing

| Decision | Options | Recommendation |
|---|---|---|
| Image panel width in presentation mode | `45%` fixed ratio vs. `50%` vs. fixed px | `45%` — leaves enough column for ring + text at any width |
| Waveform in presentation mode | Hide, dim, or keep full opacity | Dim to `0.35` — shows audio activity without competing with output text |
| Revert trigger | Button only, keyword only, or both | Both — button for mouse users, keyword for voice-only sessions |
| Pres-output font size | Match chat (`13px`) vs. larger (`15px`) | `15px` — more readable at a glance in the open layout |
| Auto-revert after audio ends | Yes (return to chat when speaking finishes) vs. No | No for v1 — user controls revert; avoids jarring snap-back mid-reading |

---

### Verification Checklist

1. Trigger an image response — confirm ring shifts right, image slides in left, chat fades out, text streams below ring
2. All transitions should complete within ~0.5 s with no layout jank
3. Conversation history remains intact — revert to chat and confirm previous messages are visible
4. Click EXIT button — confirm full revert animation
5. Say "go back" via mic — confirm revert without LLM round-trip
6. Clear conversation in presentation mode — confirm both chat and image panel clear, mode exits
7. Ask a second image-trigger question in presentation mode — confirm image updates without double-entering the mode
8. Resize browser window to narrow width — confirm `.main-col` doesn't collapse below usable size (set `min-width` guard if needed)

---

### Expected Result

| Scenario | Before | After |
|---|---|---|
| Topic with a manifest image | Image panel slides in beside chat | Full layout shift — image left, ring+text right, chat hidden |
| Topic without a manifest image | No change | No change |
| User says "go back" | N/A (no mode) | Instant revert, no LLM call, chat reappears |
| User clicks EXIT | N/A | Same revert |
| Clear conversation | Chat wipes | Chat wipes, presentation mode exits, image clears |

---

## IDEA-005 — Mouse Proximity Reactivity (Sphere & Orbs)  [COMPLETED✅]

**Status**: Ready to implement  
**Effort**: Small (frontend-only, `app.js` / Three.js `animate()` loop)  
**Impact**: Makes the visual feel alive and aware — the sphere and orbs respond to the user's physical presence on screen, adding personality without affecting any functional state

### Problem

The sphere and orbs are purely reactive to audio/speech state. The mouse cursor moving across the screen has no effect, making the visual feel passive and disconnected from the user outside of voice interactions.

### Solution

Track the cursor position relative to the sphere's canvas centre. Compute a normalised proximity value (`0` = far away, `1` = touching the sphere edge) and drive two separate reaction tiers from it:

- **Proximity tier** — cursor within a configurable radius of the sphere centre: orbs shift toward light red and the sphere surface displacement increases slightly (looks agitated / flinching)
- **UI hover tier** — cursor hovering over any interactive button or dropdown: a softer, cooler tint (pale blue-white) and a small speed bump, suggesting alertness without alarm

Both tiers blend smoothly via the existing `orbSpeedMult` lerp pattern and new per-orb colour lerp state, and they yield immediately when a real speech state (listening, speaking) takes over.

---

### Implementation Plan

#### Step 1 — Track mouse position

Add a global mouse position tracker near the top of `app.js`, after the DOM refs block:

```js
// Normalised mouse position in viewport pixels (updated on every mousemove)
let _mouseX = -9999;
let _mouseY = -9999;
document.addEventListener('mousemove', e => { _mouseX = e.clientX; _mouseY = e.clientY; });
document.addEventListener('mouseleave', () => { _mouseX = -9999; _mouseY = -9999; });
```

---

#### Step 2 — Compute proximity each frame

Inside `animate()`, after the existing `orbSpeedMult` lerp block, compute the cursor's distance from the sphere's canvas centre each frame:

```js
// Get canvas centre in viewport coordinates
const rect   = renderer.domElement.getBoundingClientRect();
const cxPx   = rect.left + rect.width  * 0.5;
const cyPx   = rect.top  + rect.height * 0.5;

// Sphere radius in pixels (use the smaller canvas dimension as a proxy)
const sphereRadiusPx = Math.min(rect.width, rect.height) * 0.5 * 0.55; // 0.55 ≈ visual sphere edge

const distPx = Math.hypot(_mouseX - cxPx, _mouseY - cyPx);

// proximity: 0 when far away, ramps to 1 when cursor touches sphere edge, >1 if inside
const PROX_RAMP_START = sphereRadiusPx * 2.5;   // starts reacting at 2.5× sphere radius
const rawProx = 1 - Math.min(1, Math.max(0, (distPx - sphereRadiusPx) / (PROX_RAMP_START - sphereRadiusPx)));
// Smooth with a lerp so it doesn't snap
proximityVal += (rawProx - proximityVal) * 0.06;
```

Declare `let proximityVal = 0;` alongside the other animation state variables at the top of `initSphere()` or at module scope.

---

#### Step 3 — Detect UI hover

Add a lightweight hover flag driven by `mouseenter`/`mouseleave` on every interactive element:

```js
let _uiHovered = false;
const UI_HOVER_ELS = ['mic-btn', 'send-btn', 'clear-btn', 'tts-toggle', 'voice-select', 'text-input'];
UI_HOVER_ELS.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mouseenter', () => { _uiHovered = true;  });
  el.addEventListener('mouseleave', () => { _uiHovered = false; });
});
```

---

#### Step 4 — Blend orb colour per-frame

The current orb colour is a single constant selected by speech state. Replace it with a lerped `THREE.Color` that blends toward the reaction tint when `proximityVal` or `_uiHovered` is active, and yields to speech state colours otherwise.

Declare lerp targets and current colour state alongside `orbDefs`:

```js
const ORB_COLOR_IDLE     = new THREE.Color(0xffffff);  // white
const ORB_COLOR_LISTEN   = new THREE.Color(0x88bbff);  // blue
const ORB_COLOR_SPEAK    = new THREE.Color(0xffdd88);  // warm yellow
const ORB_COLOR_AGITATED = new THREE.Color(0xff8888);  // light red — proximity alarm
const ORB_COLOR_AWARE    = new THREE.Color(0xaaccff);  // pale blue — UI hover awareness

// Per-orb lerp colour (initialised to idle white)
const orbCurrentColors = orbDefs.map(() => new THREE.Color(0xffffff));
```

Inside `animate()`, after computing `proximityVal`, determine the target colour for this frame:

```js
let orbColorTarget;
if (isListening)            orbColorTarget = ORB_COLOR_LISTEN;
else if (isSpeaking)        orbColorTarget = ORB_COLOR_SPEAK;
else if (proximityVal > 0.05) orbColorTarget = ORB_COLOR_AGITATED.clone().lerp(ORB_COLOR_IDLE, 1 - proximityVal);
else if (_uiHovered)        orbColorTarget = ORB_COLOR_AWARE;
else                        orbColorTarget = ORB_COLOR_IDLE;
```

Then in the orb update loop, replace the direct `.color.set(hex)` call with a lerp:

```js
// Replace: orb.light.color.set(isListening ? ORB_BLUE : isSpeaking ? ORB_YELLOW : ORB_WHITE);
orbCurrentColors[i].lerp(orbColorTarget, 0.04);
orb.light.color.copy(orbCurrentColors[i]);
orb.mesh.material.color.copy(orbCurrentColors[i]);
orb.mesh.material.emissive.copy(orbCurrentColors[i]);
```

---

#### Step 5 — Blend orb speed

The existing `orbSpeedMult` lerp drives speed; extend the target to include proximity:

```js
// Replace the existing single target line:
// const targetSpeedMult = isListening ? 1.6 : isSpeaking ? 1.4 : 1.0;

const targetSpeedMult = isListening ? 1.6
  : isSpeaking        ? 1.4
  : proximityVal > 0.05 ? 1.0 + proximityVal * 0.8   // up to 1.8× when cursor is on sphere
  : _uiHovered        ? 1.15                           // mild bump on UI hover
  : 1.0;
```

---

#### Step 6 — Modulate sphere displacement amplitude

The existing per-vertex audio displacement uses an `analyserData` amplitude. Add a proximity contribution so the sphere surface looks more turbulent when the cursor is close, even in silence:

```js
// Existing pattern (approximate):
const audioPush = analyserData ? ... : 0;

// Add after audioPush computation:
const proximityPush = proximityVal * 0.08;   // max 0.08 units of extra displacement
// Combine: vertex offset += audioPush + proximityPush  (apply per vertex in the loop)
```

---

### Files Changed

| File | Change |
|---|---|
| `frontend/app.js` | Mouse tracker; `proximityVal` computation in `animate()`; `_uiHovered` flag; per-orb colour lerp; speed mult extension; vertex displacement extension |
| `frontend/index.html` | **None** |
| `frontend/style.css` | **None** |
| `backend/` | **None** |

---

### Design Decisions to Confirm Before Implementing

| Decision | Options | Recommendation |
|---|---|---|
| Proximity ramp start distance | 1.5×, 2×, or 2.5× sphere radius | 2.5× — reaction begins well before the cursor reaches the sphere edge |
| Agitated colour | Deep red vs. light red vs. orange-red | Light red (`#ff8888`) — alarmed but not angry; matches the soft aesthetic |
| UI hover colour | Pale blue vs. brighter blue vs. white pulse | Pale blue (`#aaccff`) — softer than the listening blue, clearly distinct from idle |
| Speed ceiling on proximity | 1.6× (match listen) vs. 1.8× vs. 2× | 1.8× — noticeably faster than idle without being frantic |
| Sphere displacement on proximity | Yes vs. no | Yes — visual turbulence sells the "agitated" metaphor |
| Speech state takes priority | Always vs. blend | Always — speech state colours and speeds override proximity entirely |

---

### Verification Checklist

1. Move cursor slowly toward the sphere from a distance — confirm orbs fade from white toward light red as distance closes
2. Move cursor away — confirm smooth fade back to white (not a snap)
3. Hover over mic button — confirm mild pale-blue tint and slight speed increase
4. Move off the button — confirm return to idle white
5. Start speaking (TTS) while cursor is near the sphere — confirm yellow speaking colour takes over immediately
6. Start listening (mic active) while cursor is near — confirm blue overrides proximity red
7. Confirm no visible frame-rate impact (no extra `getBoundingClientRect` calls per-vertex — only once per frame at the top of `animate()`)

---

### Expected Result

| Scenario | Before | After |
|---|---|---|
| Cursor approaches sphere | No reaction | Orbs fade toward light red, orbits quicken, surface ripples |
| Cursor retreats | No reaction | Smooth return to white idle |
| Cursor hovers a button/dropdown | No reaction | Pale blue tint, slight speed increase |
| TTS speaking fires | Yellow orbs | Yellow overrides any proximity tint |
| Mic listening fires | Blue orbs | Blue overrides any proximity tint |

---
