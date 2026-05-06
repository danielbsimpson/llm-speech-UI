# S.T.A.R.L.I.N.G. — Improvement Ideas

A running log of planned enhancements, each with enough detail to roll out independently.

---

## IDEA-001 — Sentence-Chunked TTS (Reduce Audio Lag)

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

**Status**: Ready to implement  
**Effort**: Medium (new backend router + frontend panel + prompt engineering)  
**Impact**: When STARLING talks about a named subject, a relevant image appears to the left of the chat box while it speaks — making responses more informative and visually engaging

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
