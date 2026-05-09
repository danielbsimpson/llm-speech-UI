"""
backend/rag.py — RAG retrieval system for S.T.A.R.L.I.N.G.

Techniques applied:
  Index time:  Semantic chunking + Contextual Chunk Headers (CCH)
  Query time:  Fusion retrieval (BM25 + vector cosine via ChromaDB),
               Reciprocal Rank Fusion, RSE-lite context window expansion

Gated by RAG_ENABLED=true in .env — all public functions return safe empty
values when disabled, so callers need no special handling.

Embedding model: fastembed (ONNX-based, runs in-process, no extra server).
                 Default: BAAI/bge-small-en-v1.5 (~33 MB, downloads once).
Vector store:    ChromaDB (persistent on-disk, CPU-only, no extra VRAM).
BM25:            rank-bm25 (pure Python/NumPy, zero GPU cost).
"""

import hashlib
import os
import time
from pathlib import Path
from typing import Optional

# ── Environment config ────────────────────────────────────────────────────────
CHROMA_PATH    = os.getenv("RAG_CHROMA_PATH",    "memory/chroma_db")
INPUT_FOLDER   = os.getenv("RAG_INPUT_FOLDER",   "memory/input")
COLLECTION     = "starling_docs"
EMBED_MODEL    = os.getenv("RAG_EMBED_MODEL",    "BAAI/bge-small-en-v1.5")
CHUNK_SIZE     = int(os.getenv("RAG_CHUNK_SIZE",     "200"))
CHUNK_OVERLAP  = int(os.getenv("RAG_CHUNK_OVERLAP",  "30"))
TOP_K          = int(os.getenv("RAG_TOP_K",          "4"))
CONTEXT_WINDOW = int(os.getenv("RAG_CONTEXT_WINDOW", "1"))
MAX_TOKENS     = int(os.getenv("RAG_MAX_CONTEXT_TOKENS", "500"))
RAG_ENABLED    = os.getenv("RAG_ENABLED", "false").lower() == "true"

# ── Embedding model singleton ──────────────────────────────────────────────────
_embed_model: Optional[object] = None

def _get_embed_model():
    """Lazy-load the fastembed model once and cache it for the process lifetime."""
    global _embed_model
    if _embed_model is None:
        from fastembed import TextEmbedding
        _embed_model = TextEmbedding(model_name=EMBED_MODEL)
    return _embed_model


# ── Embedding ─────────────────────────────────────────────────────────────────

def get_embedding(text: str) -> list[float]:
    """Embed text using fastembed (ONNX, in-process — no external server needed)."""
    model = _get_embed_model()
    return list(next(model.embed([text])))


# ── Chunking ──────────────────────────────────────────────────────────────────

def semantic_chunk(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """
    Simple sentence-aware chunking.
    Splits on sentence boundaries and groups sentences into chunks of
    approximately `chunk_size` words, with a word-level overlap for continuity.
    """
    import re
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for sentence in sentences:
        words = sentence.split()
        if current_len + len(words) > chunk_size and current:
            chunks.append(" ".join(current))
            current = current[-overlap:] if overlap else []
            current_len = len(current)
        current.extend(words)
        current_len += len(words)

    if current:
        chunks.append(" ".join(current))
    return chunks


def add_cch_header(chunk: str, doc_title: str, section: Optional[str] = None) -> str:
    """
    Contextual Chunk Header (CCH): prepend document and optional section context
    to each chunk before embedding. Applied at index time only — zero query cost.
    """
    header = f"Document: {doc_title}"
    if section:
        header += f" | Section: {section}"
    return f"{header}\n\n{chunk}"


# ── Ingest ────────────────────────────────────────────────────────────────────

def ingest(folder: str = INPUT_FOLDER) -> dict:
    """
    Ingest all .txt and .md files found recursively under `folder`.

    Pipeline per file:
      text → sentence-aware chunking → CCH header → nomic-embed-text → ChromaDB upsert

    Uses upsert so re-running is idempotent (chunk ID is a hash of filepath + index + content).
    Returns a summary dict: {"ingested": N, "skipped": N, "collection": str}.
    """
    try:
        import chromadb
    except ImportError:
        return {"ingested": 0, "skipped": 0, "error": "chromadb not installed — run: pip install chromadb"}

    folder_path = Path(folder)
    if not folder_path.exists():
        return {"ingested": 0, "skipped": 0, "error": f"Input folder not found: {folder}"}

    client = chromadb.PersistentClient(path=CHROMA_PATH)
    col = client.get_or_create_collection(COLLECTION)

    ingested = 0
    skipped  = 0

    # Collect .txt and .md files (pathlib glob doesn't support brace expansion)
    filepaths = list(folder_path.glob("**/*.txt")) + list(folder_path.glob("**/*.md"))

    for filepath in filepaths:
        try:
            text = filepath.read_text(encoding="utf-8", errors="ignore")
            doc_title = filepath.stem
            chunks = semantic_chunk(text)

            for i, chunk in enumerate(chunks):
                chunk_id = hashlib.md5(
                    f"{filepath}:{i}:{chunk[:40]}".encode()
                ).hexdigest()
                enriched  = add_cch_header(chunk, doc_title)
                embedding = get_embedding(enriched)
                col.upsert(
                    ids=[chunk_id],
                    embeddings=[embedding],
                    documents=[chunk],          # raw chunk — no CCH header in the stored text
                    metadatas=[{
                        "source":       str(filepath),
                        "title":        doc_title,
                        "chunk_index":  i,
                        "total_chunks": len(chunks),
                        "ingested_at":  time.time(),
                    }],
                )
                ingested += 1
        except Exception:
            skipped += 1

    return {"ingested": ingested, "skipped": skipped, "collection": COLLECTION}


# ── Retrieve ──────────────────────────────────────────────────────────────────

def retrieve(
    query: str,
    k: int = TOP_K,
    context_window: int = CONTEXT_WINDOW,
) -> list[dict]:
    """
    Fusion retrieval (BM25 + vector cosine) fused via Reciprocal Rank Fusion.
    Post-processes with RSE-lite context window expansion (grab neighboring chunks).

    Returns list of {"text": str, "source": str, "score": float}.
    Returns [] silently when RAG is disabled, collections are empty, or dependencies
    are missing — callers never need to handle RAG-specific errors.
    """
    if not RAG_ENABLED:
        return []

    try:
        import chromadb
        from rank_bm25 import BM25Okapi
    except ImportError:
        return []

    try:
        client   = chromadb.PersistentClient(path=CHROMA_PATH)
        col      = client.get_or_create_collection(COLLECTION)
        all_docs = col.get(include=["documents", "metadatas"])

        if not all_docs["documents"]:
            return []

        # ── BM25 ─────────────────────────────────────────────────────────────
        tokenised   = [d.lower().split() for d in all_docs["documents"]]
        bm25        = BM25Okapi(tokenised)
        bm25_scores = bm25.get_scores(query.lower().split())
        bm25_ranked = sorted(
            range(len(bm25_scores)),
            key=lambda i: bm25_scores[i],
            reverse=True,
        )

        # ── Vector ────────────────────────────────────────────────────────────
        query_embedding = get_embedding(query)
        n_results       = min(k * 3, len(all_docs["documents"]))
        vector_results  = col.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
        )
        vector_ids  = vector_results["ids"][0]
        all_ids     = all_docs["ids"]
        id_to_index = {id_: idx for idx, id_ in enumerate(all_ids)}
        vector_ranked = [id_to_index[id_] for id_ in vector_ids if id_ in id_to_index]

        # ── Reciprocal Rank Fusion ────────────────────────────────────────────
        rrf_scores: dict[int, float] = {}
        for rank, idx in enumerate(bm25_ranked):
            rrf_scores[idx] = rrf_scores.get(idx, 0.0) + 1.0 / (60 + rank + 1)
        for rank, idx in enumerate(vector_ranked):
            rrf_scores[idx] = rrf_scores.get(idx, 0.0) + 1.0 / (60 + rank + 1)

        top_indices = sorted(rrf_scores, key=rrf_scores.get, reverse=True)[:k]  # type: ignore[arg-type]

        # ── RSE-lite context window expansion ─────────────────────────────────
        results: list[dict] = []
        seen: set[int]      = set()

        for idx in top_indices:
            meta    = all_docs["metadatas"][idx]
            source  = meta["source"]
            chunk_i = meta["chunk_index"]
            total   = meta["total_chunks"]

            window_indices = [idx]
            for offset in range(1, context_window + 1):
                for neighbor_i in [chunk_i - offset, chunk_i + offset]:
                    if 0 <= neighbor_i < total:
                        for j, m in enumerate(all_docs["metadatas"]):
                            if (
                                m["source"]      == source
                                and m["chunk_index"] == neighbor_i
                                and j not in seen
                            ):
                                window_indices.append(j)

            window_indices = sorted(set(window_indices))
            combined_text  = " ".join(
                all_docs["documents"][j] for j in window_indices if j not in seen
            )
            for j in window_indices:
                seen.add(j)

            if combined_text.strip():
                results.append({
                    "text":   combined_text,
                    "source": Path(source).name,
                    "score":  rrf_scores.get(idx, 0.0),
                })

        return results

    except Exception:
        return []


# ── Format ────────────────────────────────────────────────────────────────────

def format_context_for_llm(results: list[dict], max_tokens: int = MAX_TOKENS) -> str:
    """
    Serialise retrieved chunks into a system message block.
    Respects a soft word-count cap to avoid blowing the LLM context window.
    """
    if not results:
        return ""

    lines       = ["[Retrieved context — use this to inform your answer]\n"]
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


# ── Status ────────────────────────────────────────────────────────────────────

def get_status() -> dict:
    """Return RAG system status — used by the /rag/status endpoint."""
    if not RAG_ENABLED:
        return {
            "enabled":     False,
            "chunk_count": 0,
            "collection":  COLLECTION,
            "embed_model": EMBED_MODEL,
        }
    try:
        import chromadb
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        col    = client.get_or_create_collection(COLLECTION)
        count  = col.count()
        return {
            "enabled":     True,
            "chunk_count": count,
            "collection":  COLLECTION,
            "embed_model": EMBED_MODEL,
        }
    except Exception as e:
        return {"enabled": False, "error": str(e)}
