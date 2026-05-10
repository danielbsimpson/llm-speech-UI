# Wikipedia RAG — Phased Integration Guide for S.T.A.R.L.I.N.G.

> **Stack:** faster-whisper · llama.cpp (llama-server) · FastAPI · Kokoro TTS  
> **Trigger phrase:** `"wikipedia search"` (distinct from the existing `"dossier"` trigger)  
> **Mode:** Article-scoped Q&A — LLM asks the user what they want to learn, then answers only from the fetched article

---

## Phased Overview

This guide is structured as one required phase and three optional expansions. Complete Phase 1 first — it proves the entire pipeline locally with minimal storage. Then choose whichever expansion fits your priorities.

```
Phase 1   ── Required ──────────────────────────────────────────────────────
            Simple English Wikipedia dump (~250 MB compressed)
            ~200,000 articles · fast ingestion · fully offline
            Proves the full pipeline: trigger → fetch → embed → Q&A → TTS

Phase 2a  ── Optional expansion: scale up locally ──────────────────────────
            Cohere/wikipedia-22-12-en-embeddings (Hugging Face)
            Full English Wikipedia · pre-built embeddings · ~50 GB
            No re-ingestion needed · drop-in replacement for Phase 1 index

Phase 2b  ── Optional expansion: scale up via live API ─────────────────────
            Wikipedia.org REST API
            Zero local storage · trades offline for full article coverage
            Suitable if internet access is acceptable for retrieval only

Phase 3   ── Optional expansion: full local control ────────────────────────
            Full English Wikipedia XML dump (~22 GB compressed)
            Custom chunking + nomic-embed-text ingestion pipeline
            12–24 hr one-time GPU ingest · maximum offline control
```

> **You do not need to complete Phase 2a or 2b before attempting Phase 3.** After Phase 1 is working, jump to whichever expansion suits your setup. All expansions are backward-compatible — the trigger phrase, session logic, guardrails, and frontend are identical across all phases. Only the retrieval backend changes.

---

## Architecture (consistent across all phases)

```
Microphone
  → Whisper STT                        [no change]
  → Trigger detection in main.py       [extend existing logic]
      ├─ "dossier"  → existing RAG      [no change]
      └─ "wikipedia search" → NEW wikipedia_rag.py
            → Article fetch (method varies by phase)
            → Section chunking + embedding
            → WikipediaSession stored in memory
            → /wiki/chat enters guardrailed Q&A mode
                → LLM asks clarifying question first
                → Answers sourced only from article chunks
                → Hallucination guardrails in system prompt
  → Kokoro TTS                          [no change]
  → Frontend: wiki panel sidebar        [extend existing JS/CSS]
```

No existing files are deleted. Every change is an extension or addition. The dossier RAG path, Three.js sphere, Kokoro, Whisper, and llama-server relay are untouched throughout all phases.

---
---

# Phase 1 — Simple English Wikipedia (Local Dump)

**Storage:** ~250 MB compressed, ~1 GB extracted  
**Articles:** ~200,000 (Simple English subset)  
**Internet required:** Download once, then fully offline  
**Ingestion time:** 5–15 minutes on GPU  

Simple English Wikipedia uses plain, accessible language and shorter articles. It is an ideal Phase 1 target: small enough to ingest quickly, large enough to validate the full pipeline, and entirely offline after the initial download.

---

## Step 0 — Install Dependencies

Add to `requirements.txt`:

```
sentence-transformers==3.0.1
numpy>=1.26
mwxml==0.3.3
mwparserfromhell==0.6.6
tqdm==4.66.4
```

Install:

```bash
.venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

---

## Step 1 — Download the Simple English Wikipedia Dump

Wikimedia publishes monthly XML dumps at no cost. Download the Simple English dump:

```bash
# Create a directory for the dump and index
mkdir -p data/wikipedia

# Download the latest Simple English articles dump (~250 MB)
# Check https://dumps.wikimedia.org/simplewiki/latest/ for the current filename
curl -L -o data/wikipedia/simplewiki-latest-articles.xml.bz2 \
  https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles.xml.bz2
```

> On Windows, use your browser or `Invoke-WebRequest` in PowerShell:
> ```powershell
> Invoke-WebRequest `
>   -Uri "https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles.xml.bz2" `
>   -OutFile "data\wikipedia\simplewiki-latest-articles.xml.bz2"
> ```

---

## Step 2 — Ingestion Script: `scripts/ingest_wikipedia.py`

This script parses the XML dump, extracts article text section by section, embeds each chunk with `nomic-embed-text`, and writes a local index to disk. Run it once. After it completes the index is used directly at runtime — no internet, no re-embedding.

```python
# scripts/ingest_wikipedia.py
"""
One-time ingestion script for the Simple English Wikipedia XML dump.
Produces:
  data/wikipedia/chunks.npy       — float32 embeddings (N x 768)
  data/wikipedia/metadata.jsonl   — one JSON line per chunk: {title, section, text}

Run from the repository root:
  python scripts/ingest_wikipedia.py
"""

import bz2
import json
import logging
import re
import sys
from pathlib import Path

import mwxml
import mwparserfromhell
import numpy as np
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
DUMP_PATH      = Path("data/wikipedia/simplewiki-latest-articles.xml.bz2")
OUT_DIR        = Path("data/wikipedia")
CHUNKS_FILE    = OUT_DIR / "chunks.npy"
METADATA_FILE  = OUT_DIR / "metadata.jsonl"

EMBEDDING_MODEL  = "nomic-ai/nomic-embed-text-v1"
EMBEDDING_DEVICE = "cuda"     # set to "cpu" if reserving GPU for the LLM
BATCH_SIZE       = 64

MAX_CHUNK_CHARS = 800
OVERLAP_CHARS   = 80

SKIP_SECTIONS = {
    "references", "external links", "see also",
    "further reading", "notes", "footnotes", "bibliography",
    "other websites",   # Simple English Wikipedia variant
}

# ── Text helpers ──────────────────────────────────────────────────────────────

def _split_text(text: str) -> list[str]:
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks, current = [], ""
    for sentence in sentences:
        if len(current) + len(sentence) + 1 <= MAX_CHUNK_CHARS:
            current = (current + " " + sentence).strip()
        else:
            if current:
                chunks.append(current)
            overlap = current[-OVERLAP_CHARS:] if len(current) > OVERLAP_CHARS else current
            current = (overlap + " " + sentence).strip()
    if current:
        chunks.append(current)
    return chunks


def extract_chunks_from_wikitext(title: str, wikitext: str) -> list[dict]:
    """Parse wikitext into section chunks. Returns list of {title, section, text}."""
    try:
        parsed = mwparserfromhell.parse(wikitext)
    except Exception:
        return []

    results = []
    current_section = ""
    current_text = []

    for node in parsed.nodes:
        if isinstance(node, mwparserfromhell.nodes.Heading):
            # Flush previous section
            text = " ".join(current_text).strip()
            if text and current_section.lower() not in SKIP_SECTIONS:
                for chunk in _split_text(text):
                    prefix = f"[{current_section}] " if current_section else ""
                    results.append({
                        "title": title,
                        "section": current_section,
                        "text": prefix + chunk,
                    })
            current_section = node.title.strip_code().strip()
            current_text = []
        elif isinstance(node, mwparserfromhell.nodes.Text):
            line = str(node).strip()
            if line:
                current_text.append(line)

    # Flush final section
    text = " ".join(current_text).strip()
    if text and current_section.lower() not in SKIP_SECTIONS:
        for chunk in _split_text(text):
            prefix = f"[{current_section}] " if current_section else ""
            results.append({
                "title": title,
                "section": current_section,
                "text": prefix + chunk,
            })

    return results


# ── Main ingestion ─────────────────────────────────────────────────────────────

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    logger.info(f"Loading embedding model: {EMBEDDING_MODEL} on {EMBEDDING_DEVICE}")
    model = SentenceTransformer(EMBEDDING_MODEL, device=EMBEDDING_DEVICE, trust_remote_code=True)

    logger.info(f"Parsing dump: {DUMP_PATH}")
    dump = mwxml.Dump.from_file(bz2.open(str(DUMP_PATH), "rb"))

    all_chunks: list[dict] = []

    for page in tqdm(dump.pages, desc="Parsing articles", unit="articles"):
        # Skip redirects, talk pages, and non-article namespaces
        if page.namespace != 0:
            continue
        revision = next(iter(page), None)
        if revision is None or revision.redirect:
            continue
        chunks = extract_chunks_from_wikitext(page.title, revision.text or "")
        all_chunks.extend(chunks)

    logger.info(f"Extracted {len(all_chunks):,} chunks from dump")

    # Embed in batches
    texts = [c["text"] for c in all_chunks]
    logger.info(f"Embedding {len(texts):,} chunks (batch size {BATCH_SIZE}) …")
    embeddings = model.encode(
        texts,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        show_progress_bar=True,
    )

    # Save embeddings
    np.save(str(CHUNKS_FILE), embeddings.astype(np.float32))
    logger.info(f"Saved embeddings → {CHUNKS_FILE}")

    # Save metadata
    with open(METADATA_FILE, "w", encoding="utf-8") as f:
        for chunk in all_chunks:
            f.write(json.dumps(chunk, ensure_ascii=False) + "\n")
    logger.info(f"Saved metadata → {METADATA_FILE}")

    logger.info("Ingestion complete.")


if __name__ == "__main__":
    main()
```

Run once from the repository root:

```bash
python scripts/ingest_wikipedia.py
```

Expected output files:

```
data/wikipedia/chunks.npy        # float32 embedding matrix
data/wikipedia/metadata.jsonl    # one JSON line per chunk
```

---

## Step 3 — New Backend File: `backend/wikipedia_rag.py`

This file is the runtime retrieval engine. It loads the pre-built index once at startup, then serves similarity searches in milliseconds.

```python
# backend/wikipedia_rag.py
"""
Wikipedia RAG runtime for S.T.A.R.L.I.N.G.
Loads the pre-built local index and exposes:
  - start_wikipedia_session(title)   → WikipediaSession
  - retrieve_chunks(query, top_k)    → list[str]
  - build_wiki_system_prompt(chunks) → str
  - get_session() / clear_session()
  - load_index() / get_embed_model() — called at startup
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
INDEX_DIR        = Path("../data/wikipedia")      # relative to backend/
CHUNKS_FILE      = INDEX_DIR / "chunks.npy"
METADATA_FILE    = INDEX_DIR / "metadata.jsonl"

EMBEDDING_MODEL  = "nomic-ai/nomic-embed-text-v1"
EMBEDDING_DEVICE = "cuda"


# ── Index loader — loaded once at startup ─────────────────────────────────────
class _Index:
    def __init__(self):
        self.embeddings: Optional[np.ndarray] = None
        self.metadata: list[dict] = []
        self._loaded = False

    def load(self):
        if self._loaded:
            return
        logger.info(f"Loading Wikipedia index from {INDEX_DIR}")
        self.embeddings = np.load(str(CHUNKS_FILE))
        with open(METADATA_FILE, "r", encoding="utf-8") as f:
            self.metadata = [json.loads(line) for line in f]
        self._loaded = True
        logger.info(f"Index loaded: {len(self.metadata):,} chunks")

    def search_by_title(self, title_query: str) -> list[int]:
        """Return indices of all chunks whose article title matches."""
        q = title_query.lower()
        return [
            i for i, m in enumerate(self.metadata)
            if q in m["title"].lower()
        ]

    def find_closest_title(self, query: str) -> Optional[str]:
        """Return the article title with the most chunks matching the query."""
        q = query.lower()
        counts: dict[str, int] = {}
        for m in self.metadata:
            if q in m["title"].lower():
                counts[m["title"]] = counts.get(m["title"], 0) + 1
        if not counts:
            return None
        return max(counts, key=lambda t: counts[t])


_index = _Index()

def load_index():
    """Call at FastAPI startup to pre-load the index."""
    _index.load()


# ── Embedding model ───────────────────────────────────────────────────────────
_embed_model: Optional[SentenceTransformer] = None

def get_embed_model() -> SentenceTransformer:
    global _embed_model
    if _embed_model is None:
        logger.info(f"Loading embedding model {EMBEDDING_MODEL} on {EMBEDDING_DEVICE}")
        _embed_model = SentenceTransformer(
            EMBEDDING_MODEL,
            device=EMBEDDING_DEVICE,
            trust_remote_code=True,
        )
    return _embed_model


# ── Session state ─────────────────────────────────────────────────────────────
@dataclass
class WikipediaSession:
    article_title: str
    summary: str
    chunk_indices: list[int]          # indices into the global index for this article
    article_embeddings: np.ndarray    # subset of global embeddings for this article
    created_at: float = field(default_factory=time.time)
    active: bool = True

    def to_status(self) -> dict:
        return {
            "active": self.active,
            "title": self.article_title,
            "chunk_count": len(self.chunk_indices),
            "summary": self.summary,
        }


_current_session: Optional[WikipediaSession] = None


def get_session() -> Optional[WikipediaSession]:
    return _current_session

def clear_session() -> None:
    global _current_session
    _current_session = None


# ── Session start ─────────────────────────────────────────────────────────────
def start_wikipedia_session(query: str) -> WikipediaSession:
    """
    Find the closest matching article in the local index, build a session,
    and return it. Raises ValueError if no match is found.
    """
    global _current_session

    if not _index._loaded:
        _index.load()

    title = _index.find_closest_title(query)
    if title is None:
        raise ValueError(f"No article found in local index matching: '{query}'")

    chunk_indices = _index.search_by_title(title)
    if not chunk_indices:
        raise ValueError(f"Article '{title}' found but has no chunks in index.")

    article_embeddings = _index.embeddings[chunk_indices]

    # Build a summary from the first lead-section chunk
    lead_chunks = [
        _index.metadata[i]["text"] for i in chunk_indices
        if not _index.metadata[i].get("section")
    ]
    lead_text = lead_chunks[0] if lead_chunks else _index.metadata[chunk_indices[0]]["text"]
    summary_sentences = re.split(r'(?<=[.!?])\s+', lead_text)[:3]
    summary = " ".join(summary_sentences)

    _current_session = WikipediaSession(
        article_title=title,
        summary=summary,
        chunk_indices=chunk_indices,
        article_embeddings=article_embeddings,
    )
    logger.info(f"Wikipedia session started: '{title}' ({len(chunk_indices)} chunks)")
    return _current_session


# ── Retrieval ─────────────────────────────────────────────────────────────────
def retrieve_chunks(query: str, top_k: int = 4) -> list[str]:
    """Return the top_k most relevant chunks from the active article session."""
    session = _current_session
    if session is None:
        return []

    model = get_embed_model()
    query_vec = model.encode([query], normalize_embeddings=True)[0]
    scores = session.article_embeddings @ query_vec
    top_local = np.argsort(scores)[::-1][:top_k]
    top_global = [session.chunk_indices[i] for i in top_local]
    return [_index.metadata[i]["text"] for i in top_global]


# ── System prompt ─────────────────────────────────────────────────────────────
WIKI_SYSTEM_PROMPT_TEMPLATE = """You are S.T.A.R.L.I.N.G., operating in Wikipedia Article Mode.

ARTICLE IN CONTEXT: "{title}"

You have been given excerpts from the Wikipedia article above. Your behaviour \
in this mode is strictly governed by the following rules:

RULES:
1. You MUST only answer questions using information present in the provided \
article excerpts below.
2. If the answer to a question is not found in the excerpts, say clearly: \
"That detail isn't covered in this article." Do not guess, infer, or \
supplement with outside knowledge.
3. Do not present any information as fact unless it appears directly in the excerpts.
4. Do not reference other Wikipedia articles, external sources, or your own \
training data.
5. Keep answers concise and suitable for spoken audio — 2 to 4 sentences \
unless more is needed for accuracy.
6. After each answer, invite the user to ask another question about the article \
with a brief prompt such as "What else would you like to know?"

ARTICLE EXCERPTS:
{excerpts}

This is the first turn of the session. Greet the user, confirm which article \
has been loaded, and ask what they would like to learn from it."""


def build_wiki_system_prompt(excerpts: list[str]) -> str:
    session = _current_session
    if session is None:
        return ""
    formatted = "\n\n---\n\n".join(excerpts)
    return WIKI_SYSTEM_PROMPT_TEMPLATE.format(
        title=session.article_title,
        excerpts=formatted,
    )
```

---

## Step 4 — Modify `backend/main.py`

### 4a — Imports

```python
from wikipedia_rag import (
    start_wikipedia_session,
    retrieve_chunks,
    build_wiki_system_prompt,
    get_session,
    clear_session,
    load_index,
    get_embed_model,
)
```

### 4b — Startup warm-up

Locate your existing `@app.on_event("startup")` handler and add:

```python
@app.on_event("startup")
async def startup_event():
    # ... existing Whisper and Kokoro warm-up ...

    import asyncio
    loop = asyncio.get_event_loop()

    # Pre-load the Wikipedia index and embedding model
    await loop.run_in_executor(None, load_index)
    await loop.run_in_executor(None, get_embed_model)
    logger.info("Wikipedia index and embedding model warmed up")
```

### 4c — Trigger phrase detection

Add alongside the existing `"dossier"` trigger logic:

```python
import re as _re

WIKI_TRIGGER_PATTERN = _re.compile(r'\bwikipedia\s+search\b', _re.IGNORECASE)

def extract_wiki_query(transcript: str) -> str | None:
    """
    Returns the search query following 'wikipedia search', or None if absent.
    e.g. "wikipedia search Albert Einstein" → "Albert Einstein"
         "wikipedia search"                 → ""  (frontend will prompt)
    """
    match = WIKI_TRIGGER_PATTERN.search(transcript)
    if not match:
        return None
    query = transcript[match.end():].strip()
    query = _re.sub(r'\s+(please|now|for me)$', '', query, flags=_re.IGNORECASE)
    return query


# In your /transcribe or /chat handler, after getting the transcript:
wiki_query = extract_wiki_query(transcript)
if wiki_query is not None:
    return {
        "event": "wiki_trigger",
        "query": wiki_query,   # may be empty string — frontend will ask
    }
```

### 4d — New API routes

```python
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

class WikiSearchRequest(BaseModel):
    query: str

class WikiChatRequest(BaseModel):
    message: str
    history: list


@app.post("/wiki/start")
async def wiki_start(req: WikiSearchRequest):
    try:
        session = start_wikipedia_session(req.query)
        return session.to_status()
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Wikipedia lookup failed: {e}")


@app.get("/wiki/status")
async def wiki_status():
    session = get_session()
    if session is None:
        return {"active": False}
    return session.to_status()


@app.post("/wiki/clear")
async def wiki_clear():
    clear_session()
    return {"cleared": True}


@app.post("/wiki/chat")
async def wiki_chat(req: WikiChatRequest):
    session = get_session()
    if session is None:
        raise HTTPException(status_code=400, detail="No active Wikipedia session.")

    # First-turn handshake — seed retrieval with the article title
    effective_message = req.message
    if req.message == "__wiki_first_turn__":
        effective_message = session.article_title

    relevant_chunks = retrieve_chunks(effective_message, top_k=4)
    system_prompt = build_wiki_system_prompt(relevant_chunks)

    from llama_server import stream_chat   # adjust if using ollama.py

    async def generate():
        async for chunk in stream_chat(
            message="" if req.message == "__wiki_first_turn__" else req.message,
            history=req.history,
            system_prompt=system_prompt,
        ):
            yield chunk

    return StreamingResponse(generate(), media_type="application/x-ndjson")
```

---

## Step 5 — `llama_server.py` Compatibility

The `/wiki/chat` route passes a custom `system_prompt` to `stream_chat`. If the parameter does not already exist, add it with a default fallback:

```python
# backend/llama_server.py

async def stream_chat(
    message: str,
    history: list,
    system_prompt: str | None = None,   # ← add if not present
):
    effective_system = system_prompt or DEFAULT_SYSTEM_PROMPT
    messages = [{"role": "system", "content": effective_system}]
    for turn in history:
        messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": message})
    # rest of streaming logic unchanged
    ...
```

---

## Step 6 — Frontend

### `frontend/index.html` — add the panel div

```html
<!-- Wikipedia Article Panel — hidden by default -->
<div id="wiki-panel" class="wiki-panel hidden"></div>
```

### `frontend/app.js` — wiki state and handlers

```javascript
// ── Wikipedia session state ──────────────────────────────────────────────
let wikiSession = null;
let wikiHistory = [];

const WikiState = { LOADING: "wiki_loading", ACTIVE: "wiki_active" };

// Called when STT response contains { event: "wiki_trigger", query }
async function handleWikiTrigger(query) {
  setState(WikiState.LOADING);
  showWikiPanel(null);

  let articleQuery = query;
  if (!articleQuery) {
    await speak("Which article would you like to search?");
    articleQuery = await listenOnce();
  }

  try {
    const resp = await fetch("/wiki/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: articleQuery }),
    });

    if (!resp.ok) {
      await speak(`Sorry, I couldn't find an article for ${articleQuery} in the local index.`);
      setState("idle");
      hideWikiPanel();
      return;
    }

    wikiSession = await resp.json();
    wikiHistory = [];
    setState(WikiState.ACTIVE);
    showWikiPanel(wikiSession);

    await speak(`I've loaded the article on ${wikiSession.title}. ${wikiSession.summary}`);
    await sendWikiMessage("", firstTurn = true);

  } catch (e) {
    console.error("Wiki start error:", e);
    setState("idle");
    hideWikiPanel();
  }
}

async function sendWikiMessage(userMessage, firstTurn = false) {
  if (!firstTurn && userMessage.trim() === "") return;

  const EXIT_PHRASES = ["exit wikipedia", "close article", "back to normal"];
  if (EXIT_PHRASES.some(p => userMessage.toLowerCase().includes(p))) {
    await fetch("/wiki/clear", { method: "POST" });
    wikiSession = null;
    wikiHistory = [];
    hideWikiPanel();
    setState("idle");
    await speak("Wikipedia mode closed. Back to normal.");
    return;
  }

  setState("thinking");

  if (!firstTurn) {
    wikiHistory.push({ role: "user", content: userMessage });
    appendWikiMessage("user", userMessage);
  }

  const response = await fetch("/wiki/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: firstTurn ? "__wiki_first_turn__" : userMessage,
      history: wikiHistory,
    }),
  });

  let assistantText = "";
  setState("speaking");
  for await (const chunk of readNDJSON(response.body)) {
    if (chunk.token) {
      assistantText += chunk.token;
      updateWikiStreamingMessage(chunk.token);
    }
  }

  wikiHistory.push({ role: "assistant", content: assistantText });
  finalizeWikiMessage(assistantText);
  await speak(assistantText);
  setState(WikiState.ACTIVE);
}

// ── Panel DOM helpers ────────────────────────────────────────────────────
function showWikiPanel(session) {
  const panel = document.getElementById("wiki-panel");
  panel.classList.remove("hidden");
  if (!session) {
    panel.innerHTML = `
      <div class="wiki-header">
        <span class="wiki-spinner"></span>
        <span>Searching local index…</span>
      </div>
      <div id="wiki-transcript"></div>`;
    return;
  }
  panel.innerHTML = `
    <div class="wiki-header">
      <span class="wiki-icon">📖</span>
      <span class="wiki-title">${session.title}</span>
      <button class="wiki-close" onclick="exitWikiMode()">✕ Exit</button>
    </div>
    <div class="wiki-meta">${session.chunk_count} sections indexed · local</div>
    <div id="wiki-transcript" class="wiki-transcript"></div>`;
}

function hideWikiPanel() {
  const panel = document.getElementById("wiki-panel");
  panel.classList.add("hidden");
  panel.innerHTML = "";
}

function appendWikiMessage(role, text) {
  const t = document.getElementById("wiki-transcript");
  if (!t) return;
  const div = document.createElement("div");
  div.className = `wiki-message wiki-${role}`;
  div.textContent = text;
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
}

function updateWikiStreamingMessage(token) {
  let el = document.getElementById("wiki-streaming");
  if (!el) {
    el = document.createElement("div");
    el.id = "wiki-streaming";
    el.className = "wiki-message wiki-assistant wiki-streaming";
    document.getElementById("wiki-transcript").appendChild(el);
  }
  el.textContent += token;
  document.getElementById("wiki-transcript").scrollTop = 9999;
}

function finalizeWikiMessage(fullText) {
  const el = document.getElementById("wiki-streaming");
  if (el) { el.id = ""; el.classList.remove("wiki-streaming"); }
}

async function exitWikiMode() {
  await fetch("/wiki/clear", { method: "POST" });
  wikiSession = null;
  wikiHistory = [];
  hideWikiPanel();
  setState("idle");
}
```

### `frontend/style.css` — wiki panel styles

```css
.wiki-panel {
  position: fixed;
  right: 1.5rem;
  top: 4rem;
  width: 360px;
  max-height: calc(100vh - 6rem);
  background: rgba(10, 10, 14, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  backdrop-filter: blur(12px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  z-index: 100;
  transition: opacity 0.25s ease;
}
.wiki-panel.hidden { display: none; }
.wiki-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.03);
}
.wiki-icon { font-size: 1.1rem; flex-shrink: 0; }
.wiki-title {
  flex: 1;
  color: #a8c8ff;
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wiki-close {
  background: none;
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.5);
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  font-size: 0.7rem;
  cursor: pointer;
  transition: all 0.15s;
}
.wiki-close:hover { border-color: rgba(255,100,100,0.5); color: #ff9999; }
.wiki-meta {
  font-size: 0.7rem;
  color: rgba(255,255,255,0.3);
  padding: 0.3rem 1rem;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.wiki-transcript {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.1) transparent;
}
.wiki-message {
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  font-size: 0.8rem;
  line-height: 1.5;
  word-wrap: break-word;
}
.wiki-user {
  background: rgba(100,160,255,0.12);
  border: 1px solid rgba(100,160,255,0.2);
  color: #c8deff;
  align-self: flex-end;
  text-align: right;
}
.wiki-assistant {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.85);
  align-self: flex-start;
}
.wiki-streaming { border-style: dashed; opacity: 0.85; }
.wiki-spinner {
  width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,0.2);
  border-top-color: #a8c8ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 768px) {
  .wiki-panel {
    right: 0; left: 0; top: auto; bottom: 0;
    width: 100%; max-height: 50vh;
    border-radius: 12px 12px 0 0;
  }
}
```

---

## Phase 1 — Test Checklist

```
[ ] Run ingest script — chunks.npy and metadata.jsonl created with no errors
[ ] Backend starts — index loads, embedding model warms up, /health passes
[ ] Say "wikipedia search Albert Einstein"
      → Panel appears with spinner
      → Title populates, summary spoken via Kokoro
      → LLM greets user and asks what they want to learn
[ ] Ask a question covered by the article
      → Answer streams into panel, spoken via Kokoro
      → Follow-up prompt given
[ ] Ask a question not in the article
      → LLM says "That detail isn't covered in this article"
      → No hallucination
[ ] Say "wikipedia search" with no article name
      → TTS asks which article to search
      → Session starts after spoken reply
[ ] Say "exit wikipedia"
      → Panel closes, idle state restored
[ ] Say "dossier" — existing path fires, no wiki panel shown
```

---
---

# Phase 2a — Full English Wikipedia (Pre-built Embeddings)

> **When to use this path:** Phase 1 is working and you want full English Wikipedia coverage without running your own ingestion pipeline, and you are happy to use ~50 GB of local storage.

**Storage:** ~50 GB (Hugging Face dataset cache)  
**Articles:** ~6.7 million English Wikipedia articles  
**Internet required:** One-time dataset download, then fully offline  
**Ingestion time:** None — embeddings are pre-built by Cohere  

---

## What Changes

Only `backend/wikipedia_rag.py` is replaced. The API routes, frontend, system prompt, trigger phrase, and `main.py` are **identical to Phase 1** — swap the retrieval backend, nothing else.

---

## Step 1 — Install Additional Dependencies

Add to `requirements.txt`:

```
datasets==2.20.0
faiss-cpu==1.8.0        # or faiss-gpu for GPU-accelerated search
```

---

## Step 2 — Download the Dataset (One Time)

```python
# scripts/download_cohere_wikipedia.py
# Run once — downloads to Hugging Face cache (~50 GB)
from datasets import load_dataset

ds = load_dataset(
    "Cohere/wikipedia-22-12-en-embeddings",
    split="train",
    cache_dir="data/wikipedia_cohere",
)
ds.add_faiss_index(column="emb")
ds.save_faiss_index("emb", "data/wikipedia_cohere/wikipedia.faiss")
print("Done.")
```

```bash
python scripts/download_cohere_wikipedia.py
```

---

## Step 3 — Replace `backend/wikipedia_rag.py`

The public interface (`start_wikipedia_session`, `retrieve_chunks`, `build_wiki_system_prompt`, `get_session`, `clear_session`, `load_index`, `get_embed_model`) is **identical to Phase 1**. Only the internals change.

```python
# backend/wikipedia_rag.py  (Phase 2a replacement)
from __future__ import annotations
import logging, re, time
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional
import numpy as np
from datasets import load_dataset
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

DATASET_CACHE    = "data/wikipedia_cohere"
FAISS_INDEX_PATH = "data/wikipedia_cohere/wikipedia.faiss"
EMBEDDING_MODEL  = "Cohere/Cohere-embed-multilingual-light-v3.0"
EMBEDDING_DEVICE = "cuda"

_dataset = None
_embed_model: Optional[SentenceTransformer] = None
_current_session = None


def load_index():
    global _dataset
    logger.info("Loading Cohere Wikipedia dataset …")
    _dataset = load_dataset(
        "Cohere/wikipedia-22-12-en-embeddings",
        split="train",
        cache_dir=DATASET_CACHE,
    )
    _dataset.load_faiss_index("emb", FAISS_INDEX_PATH)
    logger.info(f"Dataset loaded: {len(_dataset):,} chunks")


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = SentenceTransformer(EMBEDDING_MODEL, device=EMBEDDING_DEVICE)
    return _embed_model


@dataclass
class WikipediaSession:
    article_title: str
    summary: str
    candidate_rows: list[dict]
    created_at: float = field(default_factory=time.time)
    active: bool = True

    def to_status(self):
        return {
            "active": self.active,
            "title": self.article_title,
            "chunk_count": len(self.candidate_rows),
            "summary": self.summary,
        }


def get_session(): return _current_session
def clear_session():
    global _current_session
    _current_session = None


def start_wikipedia_session(query: str) -> WikipediaSession:
    global _current_session
    model = get_embed_model()
    query_vec = model.encode([query], normalize_embeddings=True)
    _, indices = _dataset.get_nearest_examples("emb", query_vec, k=50)
    rows = [_dataset[int(i)] for i in indices[0]]

    title = Counter(r["title"] for r in rows).most_common(1)[0][0]
    article_rows = [r for r in rows if r["title"] == title]

    lead = article_rows[0]["text"] if article_rows else ""
    summary = " ".join(re.split(r'(?<=[.!?])\s+', lead)[:3])

    _current_session = WikipediaSession(
        article_title=title,
        summary=summary,
        candidate_rows=article_rows,
    )
    return _current_session


def retrieve_chunks(query: str, top_k: int = 4) -> list[str]:
    session = _current_session
    if session is None:
        return []
    model = get_embed_model()
    q_vec = model.encode([query], normalize_embeddings=True)[0]
    texts = [r["text"] for r in session.candidate_rows]
    vecs  = np.array([r["emb"] for r in session.candidate_rows])
    scores = vecs @ q_vec
    top = np.argsort(scores)[::-1][:top_k]
    return [texts[i] for i in top]


# ── System prompt — copy verbatim from Phase 1 wikipedia_rag.py ──────────────
# (WIKI_SYSTEM_PROMPT_TEMPLATE and build_wiki_system_prompt are unchanged)
```

No changes to `main.py`, frontend, or any other file.

---
---

# Phase 2b — Wikipedia.org Live API

> **When to use this path:** Phase 1 is working and you prefer zero local storage over staying fully offline. This is the only phase that requires internet access during operation.

**Storage:** None (articles fetched and embedded on demand, held in memory per session)  
**Articles:** All of English Wikipedia, always current  
**Internet required:** Yes — for every new article fetch  
**Ingestion time:** None  

---

## What Changes

Only `backend/wikipedia_rag.py` is replaced. The API routes, frontend, system prompt, trigger phrase, and `main.py` are **identical to Phase 1**.

---

## Step 1 — Install Additional Dependency

Add to `requirements.txt`:

```
wikipedia-api==0.6.0
```

---

## Step 2 — Replace `backend/wikipedia_rag.py`

```python
# backend/wikipedia_rag.py  (Phase 2b replacement)
from __future__ import annotations
import logging, re, time
from dataclasses import dataclass, field
from typing import Optional
import numpy as np
import wikipediaapi
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

EMBEDDING_MODEL  = "nomic-ai/nomic-embed-text-v1"
EMBEDDING_DEVICE = "cuda"

_wiki = wikipediaapi.Wikipedia(
    language="en",
    user_agent="STARLING-Voice-Assistant/1.0",
)
_embed_model: Optional[SentenceTransformer] = None
_current_session = None

SKIP_SECTIONS = {
    "references", "external links", "see also",
    "further reading", "notes", "footnotes", "bibliography",
}
MAX_CHUNK_CHARS = 800
OVERLAP_CHARS   = 80


def load_index():
    pass   # no-op for API mode; satisfies the startup interface


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = SentenceTransformer(
            EMBEDDING_MODEL, device=EMBEDDING_DEVICE, trust_remote_code=True
        )
    return _embed_model


@dataclass
class WikipediaSession:
    article_title: str
    article_url: str
    summary: str
    chunks: list[str] = field(default_factory=list)
    chunk_embeddings: Optional[np.ndarray] = None
    created_at: float = field(default_factory=time.time)
    active: bool = True

    def to_status(self):
        return {
            "active": self.active,
            "title": self.article_title,
            "url": self.article_url,
            "chunk_count": len(self.chunks),
            "summary": self.summary,
        }


def get_session(): return _current_session
def clear_session():
    global _current_session
    _current_session = None


def _split_text(text):
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks, current = [], ""
    for s in sentences:
        if len(current) + len(s) + 1 <= MAX_CHUNK_CHARS:
            current = (current + " " + s).strip()
        else:
            if current: chunks.append(current)
            overlap = current[-OVERLAP_CHARS:] if len(current) > OVERLAP_CHARS else current
            current = (overlap + " " + s).strip()
    if current: chunks.append(current)
    return chunks


def start_wikipedia_session(query: str) -> WikipediaSession:
    global _current_session
    page = _wiki.page(query)
    if not page.exists():
        raise ValueError(f"Wikipedia article not found: '{query}'")

    chunks = []
    if page.summary:
        chunks.extend(_split_text(page.summary))

    def walk(sections):
        for s in sections:
            if s.title.lower() in SKIP_SECTIONS: continue
            text = s.text.strip()
            if text:
                for c in _split_text(text):
                    chunks.append(f"[{s.title}] {c}")
            walk(s.sections)

    walk(page.sections)

    model = get_embed_model()
    embeddings = model.encode(chunks, normalize_embeddings=True, show_progress_bar=False)

    summary = " ".join(re.split(r'(?<=[.!?])\s+', page.summary)[:3])
    _current_session = WikipediaSession(
        article_title=page.title,
        article_url=page.fullurl,
        summary=summary,
        chunks=chunks,
        chunk_embeddings=np.array(embeddings),
    )
    return _current_session


def retrieve_chunks(query: str, top_k: int = 4) -> list[str]:
    session = _current_session
    if session is None or session.chunk_embeddings is None:
        return []
    model = get_embed_model()
    q_vec = model.encode([query], normalize_embeddings=True)[0]
    scores = session.chunk_embeddings @ q_vec
    top = np.argsort(scores)[::-1][:top_k]
    return [session.chunks[i] for i in top]


# ── System prompt — copy verbatim from Phase 1 wikipedia_rag.py ──────────────
# (WIKI_SYSTEM_PROMPT_TEMPLATE and build_wiki_system_prompt are unchanged)
```

No changes to `main.py`, frontend, or any other file.

---
---

# Phase 3 — Full English Wikipedia XML Dump

> **When to use this path:** You want maximum local control — your own chunking strategy, your own embedding model, and zero external dependencies of any kind after the one-time download. This is the largest and most complex option and should only be attempted once Phase 1 is stable.

**Storage:** ~22 GB compressed download, ~90 GB extracted + index on disk  
**Articles:** ~6.7 million English Wikipedia articles  
**Internet required:** One-time dump download, then fully offline forever  
**Ingestion time:** 12–24 hours on a single GPU (one-time only)  

---

## What Changes

The ingestion script from Phase 1 is extended to handle the full English dump and write a FAISS index instead of a numpy array. `backend/wikipedia_rag.py` is updated to load and search the FAISS index. The API routes, frontend, system prompt, trigger phrase, and `main.py` are **identical to Phase 1**.

---

## Step 1 — Install Additional Dependency

Add to `requirements.txt`:

```
faiss-gpu==1.7.4     # or faiss-cpu if not using GPU for ANN search
```

---

## Step 2 — Download the Full English Dump

```bash
# ~22 GB compressed — plan for a long download
curl -L -o data/wikipedia/enwiki-latest-articles.xml.bz2 \
  https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles.xml.bz2
```

> On Windows use `Invoke-WebRequest` or a download manager. The file is large enough that resumable downloads are worth using.

---

## Step 3 — Full Ingestion Script: `scripts/ingest_wikipedia_full.py`

This extends the Phase 1 script in two ways: it points at the full English dump, and it writes a FAISS index rather than a numpy array (necessary at 21M+ vector scale).

```python
# scripts/ingest_wikipedia_full.py
"""
One-time ingestion for the full English Wikipedia XML dump.
Produces:
  data/wikipedia_full/wikipedia.faiss  — FAISS IndexFlatIP
  data/wikipedia_full/metadata.jsonl   — one JSON line per chunk

Runtime: 12–24 hours on a single GPU.
Run from the repository root:
  python scripts/ingest_wikipedia_full.py
"""

import bz2, json, logging, re
from pathlib import Path
import mwxml, mwparserfromhell
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger(__name__)

DUMP_PATH      = Path("data/wikipedia/enwiki-latest-articles.xml.bz2")
OUT_DIR        = Path("data/wikipedia_full")
FAISS_FILE     = OUT_DIR / "wikipedia.faiss"
METADATA_FILE  = OUT_DIR / "metadata.jsonl"

EMBEDDING_MODEL  = "nomic-ai/nomic-embed-text-v1"
EMBEDDING_DEVICE = "cuda"
BATCH_SIZE       = 512
DIM              = 768

MAX_CHUNK_CHARS = 800
OVERLAP_CHARS   = 80
SKIP_SECTIONS = {
    "references", "external links", "see also",
    "further reading", "notes", "footnotes", "bibliography",
}


def _split_text(text: str) -> list[str]:
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks, current = [], ""
    for s in sentences:
        if len(current) + len(s) + 1 <= MAX_CHUNK_CHARS:
            current = (current + " " + s).strip()
        else:
            if current: chunks.append(current)
            overlap = current[-OVERLAP_CHARS:] if len(current) > OVERLAP_CHARS else current
            current = (overlap + " " + s).strip()
    if current: chunks.append(current)
    return chunks


def extract_chunks_from_wikitext(title: str, wikitext: str) -> list[dict]:
    try:
        parsed = mwparserfromhell.parse(wikitext)
    except Exception:
        return []
    results, current_section, current_text = [], "", []
    for node in parsed.nodes:
        if isinstance(node, mwparserfromhell.nodes.Heading):
            text = " ".join(current_text).strip()
            if text and current_section.lower() not in SKIP_SECTIONS:
                for chunk in _split_text(text):
                    prefix = f"[{current_section}] " if current_section else ""
                    results.append({"title": title, "section": current_section, "text": prefix + chunk})
            current_section = node.title.strip_code().strip()
            current_text = []
        elif isinstance(node, mwparserfromhell.nodes.Text):
            line = str(node).strip()
            if line: current_text.append(line)
    text = " ".join(current_text).strip()
    if text and current_section.lower() not in SKIP_SECTIONS:
        for chunk in _split_text(text):
            prefix = f"[{current_section}] " if current_section else ""
            results.append({"title": title, "section": current_section, "text": prefix + chunk})
    return results


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    logger.info(f"Loading model: {EMBEDDING_MODEL} on {EMBEDDING_DEVICE}")
    model = SentenceTransformer(EMBEDDING_MODEL, device=EMBEDDING_DEVICE, trust_remote_code=True)

    cpu_index = faiss.IndexFlatIP(DIM)
    if EMBEDDING_DEVICE == "cuda":
        res = faiss.StandardGpuResources()
        index = faiss.index_cpu_to_gpu(res, 0, cpu_index)
    else:
        index = cpu_index

    dump = mwxml.Dump.from_file(bz2.open(str(DUMP_PATH), "rb"))
    meta_handle = open(METADATA_FILE, "w", encoding="utf-8")
    batch_texts, batch_meta = [], []

    def flush():
        if not batch_texts: return
        vecs = model.encode(batch_texts, normalize_embeddings=True, show_progress_bar=False)
        index.add(np.array(vecs, dtype=np.float32))
        for m in batch_meta:
            meta_handle.write(json.dumps(m, ensure_ascii=False) + "\n")
        batch_texts.clear()
        batch_meta.clear()

    for page in tqdm(dump.pages, desc="Ingesting", unit="articles"):
        if page.namespace != 0: continue
        revision = next(iter(page), None)
        if revision is None or revision.redirect: continue
        for chunk in extract_chunks_from_wikitext(page.title, revision.text or ""):
            batch_texts.append(chunk["text"])
            batch_meta.append(chunk)
            if len(batch_texts) >= BATCH_SIZE:
                flush()

    flush()
    meta_handle.close()

    if EMBEDDING_DEVICE == "cuda":
        index = faiss.index_gpu_to_cpu(index)
    faiss.write_index(index, str(FAISS_FILE))
    logger.info(f"Ingestion complete. {index.ntotal:,} vectors written to {FAISS_FILE}")


if __name__ == "__main__":
    main()
```

Run from the repository root:

```bash
python scripts/ingest_wikipedia_full.py
```

---

## Step 4 — Replace `backend/wikipedia_rag.py`

The public interface is again identical to Phase 1. Only the index loading and retrieval internals change to use FAISS.

```python
# backend/wikipedia_rag.py  (Phase 3 replacement)
from __future__ import annotations
import json, logging, re, time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

INDEX_DIR        = Path("../data/wikipedia_full")
FAISS_FILE       = INDEX_DIR / "wikipedia.faiss"
METADATA_FILE    = INDEX_DIR / "metadata.jsonl"
EMBEDDING_MODEL  = "nomic-ai/nomic-embed-text-v1"
EMBEDDING_DEVICE = "cuda"

_faiss_index = None
_metadata: list[dict] = []
_embed_model: Optional[SentenceTransformer] = None
_current_session = None


def load_index():
    global _faiss_index, _metadata
    logger.info("Loading FAISS index …")
    _faiss_index = faiss.read_index(str(FAISS_FILE))
    with open(METADATA_FILE, "r", encoding="utf-8") as f:
        _metadata = [json.loads(line) for line in f]
    logger.info(f"FAISS index loaded: {_faiss_index.ntotal:,} vectors")


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = SentenceTransformer(
            EMBEDDING_MODEL, device=EMBEDDING_DEVICE, trust_remote_code=True
        )
    return _embed_model


@dataclass
class WikipediaSession:
    article_title: str
    summary: str
    chunk_indices: list[int]
    created_at: float = field(default_factory=time.time)
    active: bool = True

    def to_status(self):
        return {
            "active": self.active,
            "title": self.article_title,
            "chunk_count": len(self.chunk_indices),
            "summary": self.summary,
        }


def get_session(): return _current_session
def clear_session():
    global _current_session
    _current_session = None


def start_wikipedia_session(query: str) -> WikipediaSession:
    global _current_session
    model = get_embed_model()
    q_vec = model.encode([query], normalize_embeddings=True).astype(np.float32)
    _, indices = _faiss_index.search(q_vec, 50)

    title = Counter(_metadata[i]["title"] for i in indices[0]).most_common(1)[0][0]
    chunk_indices = [int(i) for i in indices[0] if _metadata[int(i)]["title"] == title]

    lead_chunks = [_metadata[i]["text"] for i in chunk_indices if not _metadata[i].get("section")]
    lead = lead_chunks[0] if lead_chunks else _metadata[chunk_indices[0]]["text"]
    summary = " ".join(re.split(r'(?<=[.!?])\s+', lead)[:3])

    _current_session = WikipediaSession(
        article_title=title,
        summary=summary,
        chunk_indices=chunk_indices,
    )
    return _current_session


def retrieve_chunks(query: str, top_k: int = 4) -> list[str]:
    session = _current_session
    if session is None: return []
    model = get_embed_model()
    q_vec = model.encode([query], normalize_embeddings=True)[0].astype(np.float32)
    # Reconstruct only this article's vectors for re-ranking
    article_vecs = np.array([
        _faiss_index.reconstruct(i) for i in session.chunk_indices
    ], dtype=np.float32)
    scores = article_vecs @ q_vec
    top = np.argsort(scores)[::-1][:top_k]
    return [_metadata[session.chunk_indices[i]]["text"] for i in top]


# ── System prompt — copy verbatim from Phase 1 wikipedia_rag.py ──────────────
# (WIKI_SYSTEM_PROMPT_TEMPLATE and build_wiki_system_prompt are unchanged)
```

No changes to `main.py`, frontend, or any other file.

---
---

## File Change Summary (All Phases)

| File | Phase 1 | Phase 2a | Phase 2b | Phase 3 |
|---|---|---|---|---|
| `requirements.txt` | Add 5 packages | Add `datasets`, `faiss-cpu` | Add `wikipedia-api` | Add `faiss-gpu` |
| `scripts/ingest_wikipedia.py` | **New** | — | — | — |
| `scripts/ingest_wikipedia_full.py` | — | — | — | **New** |
| `scripts/download_cohere_wikipedia.py` | — | **New** | — | — |
| `backend/wikipedia_rag.py` | **New** | **Replace** internals only | **Replace** internals only | **Replace** internals only |
| `backend/main.py` | Extend once | No change | No change | No change |
| `backend/llama_server.py` | Add `system_prompt` param | No change | No change | No change |
| `frontend/app.js` | Extend once | No change | No change | No change |
| `frontend/index.html` | Add panel div | No change | No change | No change |
| `frontend/style.css` | Add panel styles | No change | No change | No change |

The public interface of `wikipedia_rag.py` (`start_wikipedia_session`, `retrieve_chunks`, `build_wiki_system_prompt`, `get_session`, `clear_session`, `load_index`, `get_embed_model`) is **identical across all phases** — `main.py` never needs to change after Phase 1 is complete.