# S.T.A.R.L.I.N.G. — RAG / Memory System Implementation Guide

> Reference doc for adding local RAG to the llm-speech-UI project.
> Constraints: fully local, GPU-shared with Whisper + Kokoro + LLM, voice latency budget < 100ms for retrieval.

---

## Table of contents

1. [Constraints and design principles](#1-constraints-and-design-principles)
2. [Technique tier list](#2-technique-tier-list)
3. [Recommended stack](#3-recommended-stack)
4. [Implementation plan](#4-implementation-plan)
5. [File and folder changes](#5-file-and-folder-changes)
6. [backend/rag.py — module spec](#6-backendragpy--module-spec)
7. [backend/main.py — integration points](#7-backendmainpy--integration-points)
8. [.env additions](#8-env-additions)
9. [requirements.txt additions](#9-requirementstxt-additions)
10. [Voice mode vs text mode tuning](#10-voice-mode-vs-text-mode-tuning)
11. [Tier 2 add-ons (optional upgrades)](#11-tier-2-add-ons-optional-upgrades)
12. [Techniques to avoid and why](#12-techniques-to-avoid-and-why)
13. [HUD and frontend hooks](#13-hud-and-frontend-hooks)
14. [Makefile targets to add](#14-makefile-targets-to-add)
15. [Testing checklist](#15-testing-checklist)

---

## 1. Constraints and design principles

| Constraint | Detail |
|---|---|
| Fully local | No cloud APIs, no embeddings sent off-device |
| Shared GPU | VRAM split between Whisper (CUDA), Kokoro (DirectML/CUDA), and the LLM — RAG must not allocate a permanent GPU chunk |
| Voice latency budget | Whisper STT ~300ms + RAG retrieval + LLM generation + Kokoro TTS chunked playback. **RAG must add < 100ms** |
| Embedding model | `nomic-embed-text` (274 MB) is already installed in the Ollama blob cache — use it, don't add another model |
| Existing backend | FastAPI + uvicorn in `backend/`, streaming `/chat` endpoint, NDJSON to frontend |

**Core principle:** any RAG technique that requires an extra LLM inference call at query time is disqualifying for voice mode. Extra calls belong at index time (offline) or behind an explicit text-mode flag.

---

## 2. Technique tier list

Sourced from [NirDiamant/RAG_Techniques](https://github.com/NirDiamant/RAG_Techniques).

### Tier 1 — Use these

Zero or near-zero query-time overhead. Safe for the live voice loop.

| Technique | Why it fits | Query latency |
|---|---|---|
| **Simple RAG** | Baseline vector cosine lookup on a local store | ~1–5ms |
| **Contextual Chunk Headers (CCH)** | Applied at index time only; prepends doc/section context to each chunk before embedding | 0ms query |
| **HyPE** (Hypothetical Prompt Embeddings) | Generates synthetic questions per chunk at index time; query time is still just a vector lookup | 0ms query |
| **Optimal chunk size** | One-time tuning exercise; short voice queries retrieve best against 128–256 token chunks | 0ms query |
| **Relevant Segment Extraction (RSE)** | Pure Python post-processing — finds contiguous multi-chunk spans around top-k hits | ~1–2ms |
| **Context window enhancement** | Grab neighboring chunks above/below the retrieved hit; pure in-memory list slicing | < 1ms |
| **Fusion Retrieval** (BM25 + vector) | BM25 is pure Python/NumPy — no GPU; combine with vector via Reciprocal Rank Fusion | ~5–15ms total |
| **Semantic chunking** | Split on semantic boundaries at index time using sentence-transformers cosine similarity | 0ms query |
| **Multi-faceted filtering** | Metadata pre-filter before vector search (date, file type, topic tag); shrinks search space | < 1ms |

### Tier 2 — Use with care

One extra local inference step. Fine for text mode; gate behind a flag for voice mode.

| Technique | Caveat | Estimated overhead |
|---|---|---|
| **Reranking** (cross-encoder) | Use `ms-marco-MiniLM-L-6` (~80MB); skip in voice mode via `RAG_RERANK` flag | ~40–80ms on GPU |
| **Hierarchical indices** | Two-tier (summary + chunk); more RAM, faster at query time once built | ~5ms query |
| **Adaptive Retrieval** | One small LLM call to classify query type; replace LLM with a tiny classifier if possible | ~200–500ms |
| **Document augmentation** | Index-time LLM calls to generate questions per chunk; zero query cost; run as offline job | 0ms query |
| **HyDE** | One LLM inference pass at query time to generate a hypothetical document | ~500ms–2s |
| **Contextual compression** | LLM summarises retrieved chunks; high quality but adds one inference round | ~500ms–2s |

### Tier 3 — Avoid for live voice

Multiple sequential LLM calls or heavy graph indexing. Adds 2–15+ seconds per turn.

| Technique | Reason |
|---|---|
| Microsoft GraphRAG | Heavy indexing (minutes/hours), large VRAM footprint, multi-LLM-call queries |
| RAPTOR | Recursive LLM summarisation tree — index and query both expensive |
| Self-RAG | Multi-step LLM evaluation loop per query |
| CRAG (Corrective RAG) | Retrieval evaluator + web search + rewriter — multiple LLM calls |
| Iterative Retrieval | Multiple retrieval rounds with LLM analysis between each |
| Query Transformations | Extra LLM rewrite call before retrieval (rewriting/step-back/sub-query) |
| Ensemble Retrieval | Multiple embedding models — competes for VRAM |

> **Note:** Tier 3 techniques could work in a future async "deep research" mode triggered by a voice command like "give me a full briefing on X" — but they must never run inside the real-time voice loop.

---

## 3. Recommended stack

```
Documents folder  →  Ingest pipeline  →  Vector store  →  Retrieval  →  LLM context
(memory/input/)       (index time)       (ChromaDB /       (< 100ms)     (prepended as
                                          FAISS local)                     system message)
```

| Layer | Choice | Notes |
|---|---|---|
| Vector store | ChromaDB (preferred) or FAISS | ChromaDB has a persistent on-disk store; FAISS is faster but in-memory only |
| Embeddings | `nomic-embed-text` via Ollama API | Already installed; `http://localhost:11434/api/embeddings` |
| Chunking | Semantic chunking + CCH headers | Run once at ingest; re-run when files change |
| Retrieval | Fusion (BM25 + vector) + RSE + context window | All local, sub-15ms |
| Optional reranker | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Toggle via `.env`; skip in voice mode |
| Context injection | Prepend as `system` role message | Keep total injected tokens under ~500 to preserve context window |

---

## 4. Implementation plan

### Phase A — Foundation (minimum viable RAG)

1. Add `chromadb` and `rank-bm25` to `requirements.txt`
2. Create `backend/rag.py` with `ingest()` and `retrieve()` functions
3. Add a `POST /rag/ingest` endpoint in `backend/main.py`
4. Add a `GET /rag/status` endpoint (chunk count, last indexed time)
5. In the `/chat` handler, call `retrieve(message)` before the LLM relay; prepend results to the system prompt
6. Gate everything behind `RAG_ENABLED=true` in `.env`
7. Add `make rag-ingest` to the Makefile

### Phase B — Quality improvements

8. Add CCH headers to the chunking pipeline
9. Add HyPE question generation at index time (uses local LLM; run offline)
10. Add BM25 fusion alongside vector search
11. Add RSE post-processing

### Phase C — UX / HUD

12. Add `MEMORY` chip to the header stats row in `frontend/app.js`
13. Show "memory active" indicator on the sphere when RAG context was injected
14. Add `MEMORY` panel button: last indexed, doc count, top entities, manual re-index

---

## 5. File and folder changes

```
llm-speech-UI/
├── backend/
│   ├── rag.py              ← NEW: ingest + retrieve + BM25/vector fusion
│   ├── main.py             ← EDIT: add /rag/ingest, /rag/status, inject context in /chat
│   └── ...
├── memory/
│   ├── input/              ← NEW: watched document folder (add to .gitignore output/)
│   └── chroma_db/          ← NEW: persistent ChromaDB store (add to .gitignore)
├── scripts/
│   └── ingest_documents.py ← NEW: standalone ingest script callable from Makefile
├── .env                    ← EDIT: add RAG_* variables
└── requirements.txt        ← EDIT: add chromadb, rank-bm25, sentence-transformers
```

Add to `.gitignore`:
```
memory/chroma_db/
memory/input/*.txt   # optional — may want to track input docs
```

---

## 6. backend/rag.py — module spec

```python
"""
RAG module for S.T.A.R.L.I.N.G.
Techniques: Semantic chunking + CCH + HyPE (index time)
            Fusion retrieval (BM25 + vector) + RSE + context window (query time)
"""

import os
import json
import time
import hashlib
from pathlib import Path
from typing import Optional

import chromadb
from rank_bm25 import BM25Okapi
# nomic-embed-text is called via the Ollama embeddings API — no extra model loaded in-process

CHROMA_PATH   = os.getenv("RAG_CHROMA_PATH", "memory/chroma_db")
INPUT_FOLDER  = os.getenv("RAG_INPUT_FOLDER", "memory/input")
COLLECTION    = "starling_docs"
EMBED_MODEL   = os.getenv("RAG_EMBED_MODEL", "nomic-embed-text")
OLLAMA_URL    = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
CHUNK_SIZE    = int(os.getenv("RAG_CHUNK_SIZE", "200"))      # tokens approx
CHUNK_OVERLAP = int(os.getenv("RAG_CHUNK_OVERLAP", "30"))
TOP_K         = int(os.getenv("RAG_TOP_K", "4"))             # reduce to 2 in voice mode
CONTEXT_WINDOW = int(os.getenv("RAG_CONTEXT_WINDOW", "1"))   # neighbor chunks each side
RERANK        = os.getenv("RAG_RERANK", "false").lower() == "true"


def get_embedding(text: str) -> list[float]:
    """Call nomic-embed-text via the local Ollama embeddings endpoint."""
    import httpx
    r = httpx.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text},
        timeout=10.0,
    )
    return r.json()["embedding"]


def semantic_chunk(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """
    Simple sentence-aware chunking.
    For Phase B: replace with sentence-transformers cosine similarity boundary detection.
    """
    import re
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    chunks, current, current_len = [], [], 0
    for sentence in sentences:
        words = sentence.split()
        if current_len + len(words) > chunk_size and current:
            chunks.append(" ".join(current))
            # overlap: keep last N words
            current = current[-overlap:] if overlap else []
            current_len = len(current)
        current.extend(words)
        current_len += len(words)
    if current:
        chunks.append(" ".join(current))
    return chunks


def add_cch_header(chunk: str, doc_title: str, section: Optional[str] = None) -> str:
    """Contextual Chunk Header: prepend doc + section context before embedding."""
    header = f"Document: {doc_title}"
    if section:
        header += f" | Section: {section}"
    return f"{header}\n\n{chunk}"


def ingest(folder: str = INPUT_FOLDER) -> dict:
    """
    Ingest all .txt and .md files in the input folder.
    Applies: semantic chunking → CCH headers → nomic-embed-text → ChromaDB upsert.
    Returns summary dict.
    """
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    col = client.get_or_create_collection(COLLECTION)
    folder_path = Path(folder)
    ingested, skipped = 0, 0

    for filepath in folder_path.glob("**/*.{txt,md}"):
        text = filepath.read_text(encoding="utf-8", errors="ignore")
        doc_title = filepath.stem
        chunks = semantic_chunk(text)

        for i, chunk in enumerate(chunks):
            chunk_id = hashlib.md5(f"{filepath}:{i}:{chunk[:40]}".encode()).hexdigest()
            enriched = add_cch_header(chunk, doc_title)
            embedding = get_embedding(enriched)
            col.upsert(
                ids=[chunk_id],
                embeddings=[embedding],
                documents=[chunk],          # store raw chunk (without header) for context injection
                metadatas=[{
                    "source": str(filepath),
                    "title": doc_title,
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "ingested_at": time.time(),
                }]
            )
            ingested += 1

    return {"ingested": ingested, "skipped": skipped, "collection": COLLECTION}


def retrieve(query: str, k: int = TOP_K, context_window: int = CONTEXT_WINDOW) -> list[dict]:
    """
    Fusion retrieval: BM25 + vector cosine, fused via Reciprocal Rank Fusion.
    Then applies Relevant Segment Extraction + context window expansion.
    Returns list of {"text": ..., "source": ..., "score": ...} dicts.
    """
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    col = client.get_or_create_collection(COLLECTION)

    all_docs = col.get(include=["documents", "metadatas"])
    if not all_docs["documents"]:
        return []

    # --- BM25 ---
    tokenised = [d.lower().split() for d in all_docs["documents"]]
    bm25 = BM25Okapi(tokenised)
    bm25_scores = bm25.get_scores(query.lower().split())
    bm25_ranked = sorted(range(len(bm25_scores)), key=lambda i: bm25_scores[i], reverse=True)

    # --- Vector ---
    query_embedding = get_embedding(query)
    vector_results = col.query(query_embeddings=[query_embedding], n_results=min(k * 3, len(all_docs["documents"])))
    vector_ids = vector_results["ids"][0]
    all_ids = all_docs["ids"]
    id_to_index = {id_: idx for idx, id_ in enumerate(all_ids)}
    vector_ranked = [id_to_index[id_] for id_ in vector_ids if id_ in id_to_index]

    # --- Reciprocal Rank Fusion ---
    rrf_scores: dict[int, float] = {}
    for rank, idx in enumerate(bm25_ranked):
        rrf_scores[idx] = rrf_scores.get(idx, 0) + 1 / (60 + rank + 1)
    for rank, idx in enumerate(vector_ranked):
        rrf_scores[idx] = rrf_scores.get(idx, 0) + 1 / (60 + rank + 1)

    top_indices = sorted(rrf_scores, key=rrf_scores.get, reverse=True)[:k]

    # --- Context window expansion (RSE-lite) ---
    results = []
    seen = set()
    for idx in top_indices:
        meta = all_docs["metadatas"][idx]
        source = meta["source"]
        chunk_i = meta["chunk_index"]
        total = meta["total_chunks"]

        # gather neighboring chunks from same source
        window_indices = [idx]
        for offset in range(1, context_window + 1):
            for neighbor_i in [chunk_i - offset, chunk_i + offset]:
                if 0 <= neighbor_i < total:
                    # find the matching id
                    for j, m in enumerate(all_docs["metadatas"]):
                        if m["source"] == source and m["chunk_index"] == neighbor_i and j not in seen:
                            window_indices.append(j)

        window_indices = sorted(set(window_indices))
        combined_text = " ".join(all_docs["documents"][j] for j in window_indices if j not in seen)
        for j in window_indices:
            seen.add(j)

        if combined_text.strip():
            results.append({
                "text": combined_text,
                "source": Path(source).name,
                "score": rrf_scores.get(idx, 0),
            })

    return results


def format_context_for_llm(results: list[dict], max_tokens: int = 500) -> str:
    """
    Format retrieved chunks for injection as a system message.
    Respects a soft token cap to avoid blowing the LLM context window.
    """
    if not results:
        return ""
    lines = ["[Retrieved context — use this to inform your answer]\n"]
    total_words = 0
    for r in results:
        words = r["text"].split()
        if total_words + len(words) > max_tokens:
            words = words[:max(0, max_tokens - total_words)]
        if words:
            lines.append(f"Source: {r['source']}\n{' '.join(words)}\n")
            total_words += len(words)
        if total_words >= max_tokens:
            break
    return "\n".join(lines)


def get_status() -> dict:
    """Return RAG system status for the /rag/status endpoint."""
    try:
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        col = client.get_or_create_collection(COLLECTION)
        count = col.count()
        return {"enabled": True, "chunk_count": count, "collection": COLLECTION, "embed_model": EMBED_MODEL}
    except Exception as e:
        return {"enabled": False, "error": str(e)}
```

---

## 7. backend/main.py — integration points

### New endpoints to add

```python
from rag import ingest, retrieve, format_context_for_llm, get_status
import asyncio

@app.post("/rag/ingest")
async def rag_ingest(background_tasks: BackgroundTasks):
    """Trigger async document ingestion. Returns immediately; runs in background."""
    background_tasks.add_task(ingest)
    return {"status": "ingesting", "folder": os.getenv("RAG_INPUT_FOLDER", "memory/input")}

@app.get("/rag/status")
async def rag_status():
    return get_status()
```

### Modify the /chat handler

In `backend/llama_server.py` (and `ollama.py` fallback), before building the messages list:

```python
RAG_ENABLED = os.getenv("RAG_ENABLED", "false").lower() == "true"
RAG_VOICE_K = int(os.getenv("RAG_VOICE_TOP_K", "2"))   # fewer chunks in voice mode
RAG_TEXT_K  = int(os.getenv("RAG_TOP_K", "4"))

async def chat_stream(message: str, history: list, mode: str = "voice"):
    context_block = ""
    if RAG_ENABLED:
        k = RAG_VOICE_K if mode == "voice" else RAG_TEXT_K
        results = retrieve(message, k=k)
        context_block = format_context_for_llm(results, max_tokens=400 if mode == "voice" else 600)

    # Prepend RAG context as an extra system message before the user turn
    messages = []
    if context_block:
        messages.append({"role": "system", "content": context_block})
    messages += history
    messages.append({"role": "user", "content": message})

    # ... existing streaming relay code unchanged ...
```

### Track RAG injection in response metadata

Optionally append `"rag_active": true` to the final NDJSON metrics chunk so the frontend can light the MEMORY indicator on the sphere.

---

## 8. .env additions

```dotenv
# RAG / Memory system
RAG_ENABLED=false               # set to true when ready to test
RAG_INPUT_FOLDER=memory/input   # watched document folder
RAG_CHROMA_PATH=memory/chroma_db
RAG_EMBED_MODEL=nomic-embed-text
RAG_CHUNK_SIZE=200              # approximate word count per chunk
RAG_CHUNK_OVERLAP=30
RAG_TOP_K=4                     # chunks retrieved in text mode
RAG_VOICE_TOP_K=2               # chunks retrieved in voice mode (fewer = faster)
RAG_CONTEXT_WINDOW=1            # neighbor chunks to expand around each hit
RAG_RERANK=false                # set to true to enable cross-encoder reranking (text mode only)
RAG_MAX_CONTEXT_TOKENS=400      # soft cap on injected context length
```

---

## 9. requirements.txt additions

```
# RAG
chromadb>=0.5.0
rank-bm25>=0.2.2
sentence-transformers>=3.0.0    # for semantic chunking boundary detection (Phase B)

# Optional: cross-encoder reranking (Tier 2, voice mode off)
# sentence-transformers already covers this via CrossEncoder class
```

> `nomic-embed-text` is served through the existing Ollama installation — no separate pip install needed.

---

## 10. Voice mode vs text mode tuning

| Parameter | Voice mode | Text mode |
|---|---|---|
| `RAG_TOP_K` | 2 | 4–6 |
| `RAG_MAX_CONTEXT_TOKENS` | 300–400 | 500–700 |
| Reranking | Off | Optional on |
| HyDE / Contextual compression | Off | Optional on |
| Context window expansion | ±1 chunk | ±2 chunks |

The frontend can pass a `mode` field in the `/chat` POST body (`"voice"` vs `"text"`) to let the backend apply the right parameters automatically.

---

## 11. Tier 2 add-ons (optional upgrades)

### Reranking (cross-encoder)

```python
# In rag.py retrieve(), after RRF scoring:
if RERANK and results:
    from sentence_transformers import CrossEncoder
    reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    pairs = [(query, r["text"]) for r in results]
    rerank_scores = reranker.predict(pairs)
    results = [r for _, r in sorted(zip(rerank_scores, results), reverse=True)]
```

### HyPE (index-time question generation)

Run this as part of the ingest pipeline, gated by an env flag:

```python
HYPE_ENABLED = os.getenv("RAG_HYPE", "false").lower() == "true"

def generate_hypothetical_questions(chunk: str, n: int = 3) -> list[str]:
    """Call local LLM to generate N questions this chunk would answer."""
    # Use the existing llama-server endpoint
    prompt = f"Generate {n} concise questions that the following text answers. Output only the questions, one per line.\n\n{chunk}"
    # ... call llama-server /completion ...
    return questions  # list of strings

# In ingest(), when HYPE_ENABLED:
for question in generate_hypothetical_questions(chunk):
    q_id = hashlib.md5(f"{chunk_id}:q:{question}".encode()).hexdigest()
    q_embedding = get_embedding(question)
    col.upsert(ids=[q_id], embeddings=[q_embedding], documents=[chunk], metadatas=[{...}])
```

### Document augmentation (offline question bank)

Same pattern as HyPE but run as a separate nightly script rather than inline during ingest:

```bash
make rag-augment   # triggers scripts/augment_documents.py
```

---

## 12. Techniques to avoid and why

| Technique | What it does | Why it breaks voice |
|---|---|---|
| Microsoft GraphRAG | Builds entity/relationship knowledge graph | Index takes hours; query fires multiple LLM calls for community summaries |
| RAPTOR | Recursive tree of abstractive summaries | Each level of the tree requires LLM calls; deep queries traverse multiple levels |
| Self-RAG | LLM decides at each step whether to retrieve and assesses result quality | 3–5 LLM calls per turn |
| CRAG | Evaluates retrieved docs, rewrites query, optionally calls web search | 2–4 LLM calls per turn |
| Iterative Retrieval | Retrieve → LLM analysis → re-retrieve → repeat | N × (retrieve + LLM) per query |
| Query Transformations | Rewrites, step-back prompts, sub-query decomposition | One extra full LLM call before retrieval even begins |
| Ensemble Retrieval | Multiple embedding models, voting/weighting | Competes for VRAM already shared with Whisper, Kokoro, and the LLM |

**Safe future use:** CRAG, GraphRAG, and RAPTOR could power an async "deep research" mode — triggered by a distinct voice command, results prepared in the background and surfaced as a dossier briefing (the dossier mode already exists in the codebase).

---

## 13. HUD and frontend hooks

### Header stats chip

In `frontend/app.js`, add to the stats row update logic:

```javascript
// After receiving /rag/status response:
const ragStatus = await fetch('/rag/status').then(r => r.json());
document.getElementById('rag-chip').textContent =
  ragStatus.enabled ? `MEM ${ragStatus.chunk_count}` : 'MEM OFF';
```

### Sphere state — "memory active"

In the NDJSON streaming handler, look for a `rag_active: true` field in the final metrics chunk and briefly pulse the sphere's orb colour to indicate RAG context was injected.

```javascript
if (data.rag_active) {
    setSphereState('memory');   // new state: orbs shift to a cool purple for 1s then return
    setTimeout(() => setSphereState('speaking'), 1000);
}
```

### MEMORY panel button

Trigger ingest from the frontend:

```javascript
async function triggerIngest() {
    await fetch('/rag/ingest', { method: 'POST' });
    // Poll /rag/status every 2s until chunk_count changes
}
```

---

## 14. Makefile targets to add

```makefile
# RAG / memory
rag-ingest:
    cd backend && python -c "from rag import ingest; print(ingest())"

rag-status:
    curl -s http://localhost:8000/rag/status | python -m json.tool

rag-augment:
    .venv/Scripts/activate && python scripts/augment_documents.py

rag-clear:
    rm -rf memory/chroma_db
    @echo "ChromaDB cleared. Run make rag-ingest to rebuild."
```

---

## 15. Testing checklist

- [ ] `nomic-embed-text` is pulled and responding at `localhost:11434/api/embeddings`
- [ ] `memory/input/` folder exists with at least one `.txt` or `.md` file
- [ ] `RAG_ENABLED=true` set in `.env`
- [ ] `make rag-ingest` completes without error; `make rag-status` shows `chunk_count > 0`
- [ ] `/chat` POST returns a response with RAG context injected (check backend logs)
- [ ] Voice latency measured end-to-end: RAG step should add < 100ms (check with `time.perf_counter` around the `retrieve()` call)
- [ ] `RAG_VOICE_TOP_K=2` confirmed faster than `RAG_TOP_K=4` in voice mode
- [ ] `RAG_ENABLED=false` completely bypasses RAG with no latency impact
- [ ] `/rag/ingest` endpoint can be called while the server is running without crashing the TTS pipeline
- [ ] Cross-encoder reranking (`RAG_RERANK=true`) tested in text mode only; confirm voice mode ignores it

---

## Reference links

- [NirDiamant/RAG_Techniques](https://github.com/NirDiamant/RAG_Techniques) — technique implementations and notebooks
- [ChromaDB docs](https://docs.trychroma.com/) — persistent local vector store
- [rank-bm25](https://github.com/dorianbrown/rank_bm25) — BM25 Python implementation
- [nomic-embed-text on Ollama](https://ollama.com/library/nomic-embed-text) — already installed
- [cross-encoder/ms-marco-MiniLM-L-6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2) — lightweight reranker
- [HyPE paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5139335) — Hypothetical Prompt Embeddings preprint
