# S.T.A.R.L.I.N.G. — Improvement Ideas

A running log of planned enhancements, each with enough detail to roll out independently.

---

## IDEA-001 — Sentence-Chunked TTS (Reduce Audio Lag) [COMPLETED]

**Status**: Ready to implement  
**Effort**: Small (frontend-only)  
**Impact**: First audio plays ~1-3 s after response starts instead of after it fully completes

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
| Time to first audio | Full generation + synthesis (~5-10 s) | First sentence synthesis only (~0.5-1.5 s after it completes in stream) |
| Backend calls per response | 1 | N (one per sentence, ~3-6 for a typical response) |
| Perceived responsiveness | Response appears, long silence, then audio | Text and audio advance together |

---

## IDEA-002 — llama.cpp Migration (Remove Ollama Wrapper) [COMPLETED]

**Status**: Implemented — llama-server running in production as the default backend  
**Effort**: Small-Medium (backend relay rewrite + one frontend line + install step)  
**Impact**: Eliminates one relay hop (FastAPI → Ollama → llama.cpp becomes FastAPI → llama.cpp), reducing time-to-first-token and removing Ollama process overhead. Noticeable speed improvement observed in practice — generation feels snappier, first-token latency is reduced.

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
| Time to first token | Ollama relay adds ~20-80 ms per request | Eliminated |
| API format | Custom Ollama NDJSON | Standard OpenAI SSE (compatible with more tooling) |
| Model management | `ollama pull` + Ollama daemon | Raw GGUF files, no daemon required |
| Multiple models | Ollama handles transparently | llama-server router mode handles transparently |

---

## IDEA-003 — Voice-Triggered Presentation Mode

**Status**: In progress — implement phases sequentially; do not jump ahead  
**Effort**: Grows phase by phase — each phase is independently testable before the next begins  
**Impact**: Establishes a voice-controlled visual presentation system, built incrementally from a simple rectangle to a full dossier layout, with RAG image loading added only once the UI mechanics are solid

### Guiding principle

Each phase must work reliably before moving to the next. The trigger words and visual transitions are the foundation — everything else (images, dossier text, RAG) is layered on top only after the interaction model is confirmed working.

---

### Phase 0 — Voice Trigger → Black Rectangle

**Status**: ✅ Complete  
**Effort**: Small (frontend-only, no backend changes)  
**Goal**: Prove the voice trigger intercept works end-to-end. When the user says a trigger phrase, a plain black rectangle appears in the upper portion of the conversation column. Nothing else changes. No animation yet.

#### What this phase does

- Client-side regex matching intercepts the STT transcript before `sendToOllama()` is called
- A trigger match sets a CSS class on `.starling` that reveals a `.pres-panel` div overlaid at the top of the right column
- An exit phrase (or the clear button) removes the class and hides the panel
- No LLM call is made for trigger or exit phrases — they are swallowed entirely
- **Critically**: the trigger regex captures everything after the dossier keyword as a `subject` string. `enterPresMode(subject)` accepts this from Phase 0 even though Phase 0 does nothing with it yet. This means Phase 4 can simply start consuming `subject` without touching Phase 0 logic.

#### Trigger design — regex with subject capture

The trigger is a single regex rather than a list of strings. This allows `"Pull up the dossier on Daniel Simpson"` to match the trigger **and** capture `"Daniel Simpson"` as the subject in one pass.

```js
// Matches: (verb) [the] dossier [on|for|about|regarding] [subject]
// Capture group 1 = subject (may be undefined if no subject was spoken)
const PRES_TRIGGER_RE = /\b(?:open|show|pull up|display|launch|activate)\b.*?\bdossier\b(?:\s+(?:on|for|about|regarding)\s+(.+))?/i;

const PRES_EXIT_PHRASES = [
  'close dossier',
  'exit dossier',
  'go back',
  'back to chat',
  'resume chat',
  'hide dossier',
];
```

Exit phrases are checked **before** the trigger regex so `"close dossier"` never accidentally matches a trigger.

#### Subject extraction

```js
/**
 * Test whether `text` matches a dossier trigger.
 * Returns { matched: true, subject: "Daniel Simpson" } or { matched: false, subject: null }.
 * subject is null when no subject was spoken (e.g. bare "open dossier").
 */
function _parseTrigger(text) {
  const m = text.match(PRES_TRIGGER_RE);
  if (!m) return { matched: false, subject: null };
  const subject = m[1] ? m[1].trim() : null;
  return { matched: true, subject };
}

function _matchesExitPhrase(text) {
  const lower = text.toLowerCase();
  return PRES_EXIT_PHRASES.some(p => lower.includes(p));
}
```

#### HTML changes (`frontend/index.html`)

Add `.pres-panel` as the first child of `.col-right`, above `.chat-panel`:

```html
<div class="col-right">

  <!-- Presentation panel — hidden until trigger fires -->
  <div class="pres-panel" id="pres-panel"></div>

  <!-- Conversation -->
  <div class="chat-panel">
    <div class="chat-inner" id="chat-inner"></div>
  </div>

</div>
```

#### CSS changes (`frontend/style.css`)

```css
/* ── Presentation panel ──────────────────────────────────────────────────── */
.pres-panel {
  flex-shrink: 0;
  height: 0;
  overflow: hidden;
  background: #000000;
  transition: height 0.35s ease;
}

.starling.pres-mode .pres-panel {
  height: 55%;   /* covers the upper portion of the right column */
}

/* Dim conversation when panel is open */
.starling.pres-mode .chat-panel {
  opacity: 0.25;
  pointer-events: none;
  transition: opacity 0.35s ease;
}
```

#### JS changes (`frontend/app.js`)

Add near the top, after `MODEL`:

```js
// Matches dossier trigger verbs and optionally captures a subject after "on/for/about/regarding"
const PRES_TRIGGER_RE = /\b(?:open|show|pull up|display|launch|activate)\b.*?\bdossier\b(?:\s+(?:on|for|about|regarding)\s+(.+))?/i;

const PRES_EXIT_PHRASES = [
  'close dossier', 'exit dossier', 'go back',
  'back to chat', 'resume chat', 'hide dossier',
];

function _parseTrigger(text) {
  const m = text.match(PRES_TRIGGER_RE);
  if (!m) return { matched: false, subject: null };
  return { matched: true, subject: m[1] ? m[1].trim() : null };
}

function _matchesExitPhrase(text) {
  const lower = text.toLowerCase();
  return PRES_EXIT_PHRASES.some(p => lower.includes(p));
}

// subject is stored now, consumed by Phase 4 RAG lookup — unused in Phase 0
let _presSubject = null;

function enterPresMode(subject) {
  _presSubject = subject ?? null;   // Phase 4 reads this to query the manifest
  starlingEl.classList.add('pres-mode');
}
function exitPresMode() {
  _presSubject = null;
  starlingEl.classList.remove('pres-mode');
}
```

Hook into the STT result handler immediately before the `sendToOllama()` call:

```js
if (_matchesExitPhrase(transcript)) {
  exitPresMode();
  setState('idle');
  return;
}
const triggerResult = _parseTrigger(transcript);
if (triggerResult.matched) {
  enterPresMode(triggerResult.subject);
  setState('idle');
  return;
}
```

> **Why this matters for Phase 4**: When the user says `"Pull up the dossier on Daniel Simpson"`, `_parseTrigger` returns `{ matched: true, subject: "Daniel Simpson" }`. Phase 4 will read `_presSubject` (or receive it as a parameter) and use it to fuzzy-search `manifest.json` for the closest key. The visual trigger, subject capture, and RAG lookup all originate from the same utterance — nothing is lost.

Also call `exitPresMode()` inside the clear button handler.

#### Verification

- Say `"open dossier"` → black rectangle appears; `_presSubject` is `null`
- Say `"pull up the dossier on Daniel Simpson"` → black rectangle appears; `console.log(_presSubject)` prints `"Daniel Simpson"`
- Say `"show dossier for Apollo 13"` → rectangle appears; `_presSubject` is `"Apollo 13"`
- Say an exit phrase → rectangle disappears, chat returns to full opacity, `_presSubject` is cleared
- Normal conversation still works without any visual changes
- No console errors, no LLM calls on trigger/exit phrases

#### Files changed

| File | Change |
|---|---|
| `frontend/index.html` | Add `.pres-panel` inside `.col-right` |
| `frontend/style.css` | Add `.pres-panel` and `.pres-mode` overrides |
| `frontend/app.js` | Phrase lists, `enterPresMode`/`exitPresMode`, STT intercept, clear-btn wiring |
| `backend/*` | **None** |

---

### Phase 1 — Neon Border Animation

**Status**: ✅ Complete  
**Effort**: Small–Medium (CSS animation + JS sequencing)  
**Goal**: Replace the plain rectangle appearance with a cinematic neon blue border draw animation. The panel content area and interior remain black; only the border animates. The sequence:

1. A single neon blue point appears at the horizontal centre of the top edge of the panel
2. It extends left and right simultaneously as a horizontal line until it reaches both side edges
3. From each corner, vertical lines extend downward simultaneously until they reach the bottom corners
4. A bottom horizontal line closes the rectangle, completing the outline

The entire sequence plays over ~800 ms. Once the outline is complete, the panel interior is fully revealed and ready for content (Phase 2).

#### Implementation approach

The animation is driven entirely by CSS `clip-path` or pseudo-element `width`/`height` transitions, sequenced with `animation-delay`. No canvas or JS drawing required.

A clean approach uses four absolutely-positioned pseudo-elements (or four `<span>` elements) inside `.pres-panel`, each representing one edge, animated in sequence:

```
span.edge-top    — starts at 50% width centred, expands to 100% width
span.edge-left   — starts at 0 height at top-left corner, grows downward
span.edge-right  — starts at 0 height at top-right corner, grows downward
span.edge-bottom — starts at 0 width centred at bottom, expands to 100%
```

Each edge is a 1–2 px neon blue line (`#00aaff` or similar) with a soft `box-shadow` glow. The delays are chained so the corners are reached before the next edge starts.

```css
.starling.pres-mode .pres-panel {
  height: 55%;
}

/* All edges hidden by default */
.pres-panel .edge { position: absolute; background: #00aaff; box-shadow: 0 0 8px #00aaff, 0 0 24px rgba(0,170,255,0.4); }

/* Top edge — horizontal, expands from centre */
.pres-panel .edge-top {
  top: 0; left: 50%; height: 1px; width: 0;
  transform: translateX(-50%);
  transition: width 0.25s ease;
}
.starling.pres-mode .edge-top { width: 100%; }

/* Side edges — expand downward, delayed until top is complete */
.pres-panel .edge-left  { top: 0; left: 0;   width: 1px; height: 0; transition: height 0.25s ease 0.25s; }
.pres-panel .edge-right { top: 0; right: 0;  width: 1px; height: 0; transition: height 0.25s ease 0.25s; }
.starling.pres-mode .edge-left,
.starling.pres-mode .edge-right { height: 100%; }

/* Bottom edge — horizontal, closes the rectangle */
.pres-panel .edge-bottom {
  bottom: 0; left: 50%; height: 1px; width: 0;
  transform: translateX(-50%);
  transition: width 0.25s ease 0.5s;
}
.starling.pres-mode .edge-bottom { width: 100%; }
```

Add the four edge spans to `.pres-panel` in the HTML:

```html
<div class="pres-panel" id="pres-panel">
  <span class="edge edge-top"></span>
  <span class="edge edge-left"></span>
  <span class="edge edge-right"></span>
  <span class="edge edge-bottom"></span>
</div>
```

On exit, removing `.pres-mode` reverses all transitions simultaneously — the border collapses. If a more deliberate collapse sequence is wanted, a `.pres-closing` class can be added briefly to reverse the delays.

#### Verification

- Trigger phrase → point appears at top centre, line draws left and right, corners turn, verticals descend, bottom closes — full sequence in ~800 ms
- Exit phrase → border fades/collapses cleanly
- Animation feels smooth at 60 fps — adjust durations if choppy
- Interior remains black throughout

#### Files changed

| File | Change |
|---|---|
| `frontend/index.html` | Add four `.edge` spans inside `.pres-panel` |
| `frontend/style.css` | Edge styles and sequenced transition delays |
| `frontend/app.js` | **None** — phase 0 JS is sufficient |
| `backend/*` | **None** |

---

### Phase 2 — Image Drop Into Panel

**Status**: ✅ Complete  
**Effort**: Small (frontend-only — static image, no RAG yet)  
**Goal**: Once the neon border animation completes, display a static placeholder image inside the panel. This confirms the layout mechanics and timing before any backend image-fetching is introduced. Use a single local test image from `assets/images/`.

#### What this phase does

- After `.pres-mode` is applied and the border animation completes (~800 ms), an `<img>` inside `.pres-panel` fades in
- The image is hardcoded to a local test file for now — no manifest, no API call
- The image fills the panel interior with `object-fit: contain`, centred, with a small inset from the neon border

#### HTML changes

```html
<div class="pres-panel" id="pres-panel">
  <span class="edge edge-top"></span>
  <span class="edge edge-left"></span>
  <span class="edge edge-right"></span>
  <span class="edge edge-bottom"></span>
  <img class="pres-image" id="pres-image" src="assets/images/test.jpg" alt="" />
</div>
```

#### CSS changes

```css
.pres-image {
  position: absolute;
  inset: 10px;          /* small gap inside the neon border */
  width: calc(100% - 20px);
  height: calc(100% - 20px);
  object-fit: contain;
  opacity: 0;
  transition: opacity 0.4s ease 0.85s;   /* delay until border animation completes */
}

.starling.pres-mode .pres-image {
  opacity: 1;
}
```

#### Verification

- Trigger → border draws → image fades in cleanly after border is complete
- Image is contained within the neon border with a visible inset gap
- Exit → image disappears with the panel
- No layout shift in the conversation column while panel is open

#### Files changed

| File | Change |
|---|---|
| `frontend/index.html` | Add `.pres-image` inside `.pres-panel` |
| `frontend/style.css` | `.pres-image` with delayed fade-in |
| `assets/images/` | Add one test image (`test.jpg`) |
| `frontend/app.js` | **None** |
| `backend/*` | **None** |

---

### Phase 3 — Full Visual Reconfiguration

**Status**: ✅ Complete  
**Effort**: Medium (CSS layout transitions + JS state updates)  
**Goal**: When the dossier trigger fires, the entire UI shifts into a four-zone presentation layout. The conversation window does **not** disappear — it repositions under the sphere in the left column. The sphere shifts up and left. The neon image panel appears near centre. The dossier text panel appears on the right. Everything reverses cleanly on exit. Filler text used in this phase; real data arrives in Phase 4.

#### Layout in presentation mode

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [header — full width, unchanged]                                        │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ● sphere (up-left)    ┌──────────────┐   ┌─────────────────────────┐   │
│                        │  [neon image]│   │  SUBJECT TITLE          │   │
│  ┌────────────────┐    │              │   │  ────────────────────── │   │
│  │  [chat window] │    │   [image]    │   │  Summary text...        │   │
│  │  repositioned  │    │              │   │                         │   │
│  │  below sphere  │    └──────────────┘   │  FIELD   VALUE          │   │
│  └────────────────┘                       │  FIELD   VALUE          │   │
│                                           └─────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────────┤
│  [bottom bar — mic, input, send — unchanged]                             │
│  [footer — unchanged]                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

#### What changes

**Overall layout**: `.body-cols` transitions from a 2-column (50/50) flex row to a 4-zone layout in `pres-mode`. This is driven entirely by CSS — no DOM reordering required.

**HTML restructure** (one-time change, applied in this phase): Move `.chat-panel` from `.col-right` into `.col-left` as a flex sibling beneath `.ring-section`. Promote `.pres-panel` and the new `.pres-dossier` to be direct children of `.body-cols` rather than children of `.col-right`. `.col-right` becomes an empty shell that shrinks to `width: 0` in pres-mode.

```
.body-cols
  ├── .col-left            ← sphere + waveform + chat-panel (flex-column)
  ├── .pres-panel          ← neon border + image  (zero-width in normal mode)
  ├── .pres-dossier        ← structured text      (zero-width in normal mode)
  └── .col-right           ← empty shell; shrinks to 0 in pres-mode
```

**Sphere**: shifts up-left via `transform: translate(-28px, -18px)` on `.col-left`. The sphere lifts slightly and moves toward the left edge, freeing vertical space for the conversation window to appear below it.

**Conversation window**: In normal mode, `.chat-panel` inside `.col-left` is `max-height: 0; opacity: 0; overflow: hidden` — invisible. In `pres-mode` it transitions to a visible height below the sphere. Chat history is fully preserved throughout; `appendMessage()` targets `#chat-inner` by ID, which doesn't move.

**Neon image panel** (`.pres-panel`): in normal mode `width: 0; overflow: hidden`. In `pres-mode` it grows to ~32% of `.body-cols` width. The border animation (Phase 1) and image (Phase 2) are already inside it.

**Dossier text panel** (`.pres-dossier`): same — `width: 0` normally, grows to ~28% in `pres-mode` and fades in after the border animation completes (~850 ms delay).

#### HTML changes (`frontend/index.html`)

Restructure `.body-cols`:

```html
<div class="body-cols">

  <!-- Left column: sphere + chat repositioned below in pres-mode -->
  <div class="col-left">
    <div class="ring-section">
      <!-- sphere canvas, halo — unchanged -->
    </div>
    <div class="waveform" id="waveform"></div>
    <!-- Chat panel lives here so it slides in below sphere in pres-mode -->
    <div class="chat-panel">
      <div class="chat-inner" id="chat-inner"></div>
    </div>
  </div>

  <!-- Neon image panel — zero-width in normal mode -->
  <div class="pres-panel" id="pres-panel">
    <span class="edge edge-top"></span>
    <span class="edge edge-left"></span>
    <span class="edge edge-right"></span>
    <span class="edge edge-bottom"></span>
    <img class="pres-image" id="pres-image" src="" alt="" />
  </div>

  <!-- Dossier text panel — zero-width in normal mode -->
  <div class="pres-dossier" id="pres-dossier">
    <div class="pres-dossier-title" id="pres-dossier-title">SUBJECT UNKNOWN</div>
    <div class="pres-dossier-body"  id="pres-dossier-body">
      Awaiting intelligence data. No records on file for this subject.
    </div>
    <div class="pres-dossier-meta" id="pres-dossier-meta">
      <span class="key">STATUS</span><span class="val">UNCLASSIFIED</span>
      <span class="key">SOURCE</span><span class="val">LOCAL KB</span>
      <span class="key">UPDATED</span><span class="val">—</span>
    </div>
  </div>

  <!-- Right column: empty shell, shrinks to zero in pres-mode -->
  <div class="col-right"></div>

</div>
```

> **Note**: `#chat-inner` keeps its ID. `appendMessage()` in `app.js` finds it by `getElementById` — no JS changes required.

#### CSS changes (`frontend/style.css`)

```css
/* ── col-left becomes a flex-column so chat stacks below sphere ─────────── */
.col-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 50%;
  transition: transform 0.5s ease, width 0.5s ease;
}

.col-right {
  width: 50%;
  transition: width 0.5s ease;
}

/* pres-panel and pres-dossier: invisible and zero-width by default */
.pres-panel {
  position: relative;
  width: 0;
  overflow: hidden;
  background: #000;
  transition: width 0.5s ease;
}

.pres-dossier {
  width: 0;
  overflow: hidden;
  opacity: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0;
  box-sizing: border-box;
  transition: width 0.5s ease, opacity 0.4s ease 0.85s, padding 0.5s ease;
}

/* Chat panel inside col-left: hidden until pres-mode */
.col-left .chat-panel {
  width: 100%;
  max-height: 0;
  overflow: hidden;
  opacity: 0;
  flex-shrink: 0;
  transition: max-height 0.5s ease 0.2s, opacity 0.4s ease 0.35s;
}

/* ── Pres-mode overrides ──────────────────────────────────────────────────── */
.starling.pres-mode .col-left {
  width: 22%;
  transform: translate(-28px, -18px);
}
.starling.pres-mode .col-right {
  width: 0;
}
.starling.pres-mode .pres-panel {
  width: 32%;
}
.starling.pres-mode .pres-dossier {
  width: 28%;
  opacity: 1;
  padding: 20px 16px;
}

/* Sphere ring nudges upward slightly */
.starling.pres-mode .ring-section {
  transform: translateY(-10px);
  transition: transform 0.5s ease;
}

/* Chat reveals below sphere */
.starling.pres-mode .col-left .chat-panel {
  max-height: 38%;
  opacity: 0.85;
}

/* ── Dossier text styles ─────────────────────────────────────────────────── */
.pres-dossier-title {
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
  letter-spacing: 4px;
  color: #e0e0e0;
  text-transform: uppercase;
  border-bottom: 0.5px solid rgba(0, 170, 255, 0.35);
  padding-bottom: 8px;
  flex-shrink: 0;
}
.pres-dossier-body {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  color: rgba(200, 200, 200, 0.65);
  line-height: 1.8;
  overflow-y: auto;
}
.pres-dossier-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 5px 18px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 9px;
  letter-spacing: 1.5px;
  flex-shrink: 0;
}
.pres-dossier-meta .key { color: rgba(0, 170, 255, 0.6); text-transform: uppercase; }
.pres-dossier-meta .val { color: rgba(200, 200, 200, 0.55); }
```

#### JS changes (`frontend/app.js`)

None beyond Phase 0. The `.pres-mode` class cascade handles all layout transitions. `enterPresMode(subject)` and `exitPresMode()` remain unchanged.

#### Verification

- Trigger → sphere lifts and shifts left; chat window slides in below sphere; neon image panel grows from centre; dossier text panel fades in from the right — all in one choreographed motion over ~1 s
- Exit → all four zones reverse; sphere returns to centre; chat collapses back to hidden; panels shrink to zero
- Chat history preserved throughout — `#chat-inner` never moves in the DOM
- New messages appended during pres-mode appear correctly in the repositioned chat window
- Bottom bar and footer unchanged throughout

#### Files changed

| File | Change |
|---|---|
| `frontend/index.html` | Restructure `.body-cols` — move `.chat-panel` into `.col-left`; promote `.pres-panel` and `.pres-dossier` as direct `.body-cols` children; empty `.col-right` shell |
| `frontend/style.css` | Four-zone width transitions; sphere/ring shift; chat reveal in `.col-left`; `.pres-dossier` text styles |
| `frontend/app.js` | **None** |
| `backend/*` | **None** |

---
### Phase 4 — RAG Image and Text Population

**Status**: 🔴 Not started — implement only after Phase 3 is visually complete and stable  
**Effort**: Medium (backend manifest + API endpoints + prompt engineering)  
**Goal**: Replace filler text and static test image with real data. When a trigger fires for a known subject, the correct image is loaded and **two sequential LLM calls** are made: one to generate the structured dossier panel, and one to feed that same data back into the normal S.T.A.R.L.I.N.G. prompt so the AI reads a summary aloud. The user sees the dossier on screen and hears STARLING describe it simultaneously.

#### What this phase does

- `assets/images/manifest.json` is the single source of truth — each entry has a key, display title, image filename, raw text body, and metadata fields
- A `backend/rag.py` router exposes `GET /rag/manifest` and `GET /rag/image/{key}`
- `app.js` loads the manifest on startup
- **Subject-to-key resolution**: `_presSubject` (captured in Phase 0 from e.g. `"pull up the dossier on Daniel Simpson"`) is passed to `_resolveManifestKey(subject)` which fuzzy-matches against manifest titles and keys — the direct payoff of the Phase 0 regex design
- **Dual LLM call sequence**: once a manifest entry is resolved, two requests fire:
  1. **Dossier prompt** — raw manifest data + a few-shot template instructing the LLM to return structured dossier output (title, 2–3 sentence body, key/value metadata rows). The streamed response populates the `.pres-dossier` panel fields in real time.
  2. **Verbal readout prompt** — the same raw manifest data is injected into the normal STARLING system prompt as context, and the LLM is asked to give a spoken briefing. This streams into the chat window and is read aloud via the normal sentence-chunked TTS pipeline.
- The two calls are **independent** — the dossier prompt fires first and streams into the panel; the verbal readout fires immediately after (or in parallel) and streams into the chat as normal speech
- Voice trigger path and `[DOSSIER:key]` LLM tag path both converge on the same `_activateDossier(key)` function

#### Dual-prompt design

```
user says: "Pull up the dossier on Apollo 13"
           │
           ▼
  _parseTrigger() → { matched: true, subject: "Apollo 13" }
  _resolveManifestKey("Apollo 13") → entry = manifest["apollo_13"]
  enterPresMode("apollo_13")       → panel visible, image loaded
           │
           ├─► Dossier prompt ──► streams into .pres-dossier panel (title, body, meta)
           │
           └─► Verbal prompt  ──► streams into chat + TTS reads aloud
                                  "Apollo 13 was NASA's seventh crewed Moon mission..."
```

#### Dossier prompt template

The dossier prompt is a separate system message, never shown in the main chat history:

```
You are a dossier formatter. Given raw subject data, output ONLY a JSON object with these exact fields:
{
  "title": "SUBJECT NAME IN CAPS",
  "body": "2-3 sentence factual summary.",
  "meta": [
    { "key": "FIELD_LABEL", "val": "value" },
    ...up to 5 rows
  ]
}
No prose. No explanation. JSON only.

Subject data:
[manifest entry body text injected here]
```

The JSON response is parsed on arrival and used to populate `#pres-dossier-title`, `#pres-dossier-body`, and `#pres-dossier-meta`.

#### Verbal readout prompt

The verbal readout re-uses the existing `sendToLlm()` flow with an augmented system prompt:

```
[Normal STARLING system prompt]

CONTEXT — Subject on screen: [manifest entry body text]
When asked to brief on this subject, give a concise 3-5 sentence spoken summary.
Do not describe the dossier panel or mention the screen layout.
```

This streams tokens into the chat window and through TTS exactly as a normal response would. The user hears STARLING speak about the subject while reading the structured dossier alongside the image.

#### Manifest schema

```json
[
  {
    "key": "apollo_13",
    "title": "APOLLO 13",
    "file": "apollo_13.jpg",
    "body": "NASA's seventh crewed Moon mission, launched April 11 1970. An oxygen tank rupture on day two forced the crew to abort the lunar landing and use the Lunar Module as a lifeboat. All three crew members returned safely on April 17 1970.",
    "meta": [
      { "key": "MISSION",  "val": "Apollo 13" },
      { "key": "DATE",     "val": "11 APR 1970" },
      { "key": "STATUS",   "val": "ABORTED — CREW SAFE" },
      { "key": "CREW",     "val": "Lovell / Swigert / Haise" }
    ]
  }
]
```

The `body` field is the raw text fed to both prompts. The `meta` array is a fallback rendered directly if the dossier LLM call fails or is skipped.

#### Files changed (Phase 4 only)

| File | Change |
|---|---|
| `assets/images/manifest.json` | Create — full manifest |
| `backend/rag.py` | Create — `GET /rag/manifest` and `GET /rag/image/{key}` |
| `backend/main.py` | Register RAG router |
| `frontend/app.js` | Manifest load on init; `_resolveManifestKey(subject)`; `_activateDossier(key)` orchestrator; dossier prompt call → panel population; verbal readout call → chat + TTS; `[DOSSIER:key]` stream tag parser as secondary trigger path |
| `frontend/style.css` | **None** — Phase 3 styles are sufficient |
| `frontend/index.html` | **None** — Phase 3 HTML is sufficient |

---

### Phase summary

| Phase | What it proves | Backend needed |
|---|---|---|
| **0 — Black rectangle** | Voice trigger intercept works | No |
| **1 — Neon border animation** | Animation sequence plays cleanly from triggers | No |
| **2 — Static image drop** | Image layout and timing work before any API | No |
| **3 — Full reconfiguration** | Complete visual mode shift is smooth and reversible | No |
| **4 — RAG population** | Real data populates the confirmed-working visual system | Yes |

---
