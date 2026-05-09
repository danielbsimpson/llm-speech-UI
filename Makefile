# ─────────────────────────────────────────────────────────────────────────────
# Makefile — S.T.A.R.L.I.N.G. developer shortcuts
#
# Requires: make (Git Bash on Windows, WSL, or Linux/Mac)
# All commands assume the repo root as working directory.
# ─────────────────────────────────────────────────────────────────────────────

.PHONY: help install backend frontend llama test lint

# Detect OS for venv activation path
ifeq ($(OS),Windows_NT)
    VENV_ACTIVATE := .venv/Scripts/activate
    PYTHON        := .venv/Scripts/python
    PIP           := .venv/Scripts/pip
else
    VENV_ACTIVATE := .venv/bin/activate
    PYTHON        := .venv/bin/python
    PIP           := .venv/bin/pip
endif

# ── Default target ────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  S.T.A.R.L.I.N.G. — available make targets"
	@echo ""
	@echo "  make install    Create venv, install deps, download Kokoro models"
	@echo "  make backend    Start FastAPI backend with hot-reload (port 8000)"
	@echo "  make frontend   Serve frontend with live-server for hot-reload (port 8001)"
	@echo "  make llama      Launch llama-server via start_llama_server.bat (Windows)"
	@echo "  make test       Run integration tests against a running backend"
	@echo "  make lint       Run ruff on the backend source"
	@echo ""

# ── Install ───────────────────────────────────────────────────────────────────
install:
	bash scripts/setup.sh

# ── Backend (hot-reload) ──────────────────────────────────────────────────────
backend:
	cd backend && $(PYTHON) -m uvicorn main:app \
	    --host 0.0.0.0 \
	    --port 8000 \
	    --reload \
	    --reload-dir .

# ── Frontend (live-server hot-reload) ─────────────────────────────────────────
# The primary frontend is served by FastAPI at http://localhost:8000.
# Use this target only when iterating on HTML/CSS/JS without a running backend.
# Requires: npx (Node.js) — install with: npm install -g live-server
frontend:
	npx live-server frontend/ --port=8001 --no-browser

# ── llama-server ─────────────────────────────────────────────────────────────
llama:
ifeq ($(OS),Windows_NT)
	scripts/start_llama_server.bat
else
	@echo "llama-server launch is configured for Windows via start_llama_server.bat."
	@echo "On Linux/Mac, run llama-server directly with the equivalent flags:"
	@echo "  llama-server --model <path> --alias llama3.2-3b --n-gpu-layers 999 --ctx-size 4096 --port 8080"
endif

# ── Integration tests ─────────────────────────────────────────────────────────
test:
	$(PYTHON) scripts/test_integration.py

# ── Lint ─────────────────────────────────────────────────────────────────────
lint:
	$(PIP) install --quiet ruff
	$(PYTHON) -m ruff check backend/

# ── RAG / memory ──────────────────────────────────────────────────────────────
.PHONY: rag-ingest rag-status rag-clear

rag-ingest:
	@echo "Ingesting documents from memory/input/ ..."
	cd backend && $(PYTHON) -c "from rag import ingest; r = ingest(); print(r)"

rag-status:
	curl -s http://localhost:8000/rag/status | $(PYTHON) -m json.tool

rag-clear:
	rm -rf memory/chroma_db
	@echo "ChromaDB cleared. Run 'make rag-ingest' to rebuild."
