# S.T.A.R.L.I.N.G. — RAG Input Documents

Place `.txt` or `.md` files here to be indexed by the RAG system.

Run `make rag-ingest` (or `POST /rag/ingest`) after adding or updating files.
The indexer walks this folder recursively, so sub-folders are fine.

**Notes**
- Files are chunked into ~200-word segments and embedded via `nomic-embed-text`
  served through the existing Ollama process — no extra model download required.
- Re-running ingest is idempotent: unchanged chunks are skipped (upsert by hash).
- The ChromaDB store lives in `memory/chroma_db/` (gitignored).
- RAG retrieval is gated by `RAG_ENABLED=true` in `.env`.
