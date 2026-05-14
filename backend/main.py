import json
import os
import re
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

load_dotenv()

# ── LLM backend selection ─────────────────────────────────────────────────────
# Set LLM_BACKEND=llama in .env to route /chat/ to llama-server instead of Ollama.
# Both backends expose the same NDJSON format so the frontend is unchanged.
# Default is "ollama" for backward compatibility.
LLM_BACKEND = os.getenv("LLM_BACKEND", "ollama").lower()

app = FastAPI(title="S.T.A.R.L.I.N.G. Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from stt import router as stt_router
from tts import router as tts_router

if LLM_BACKEND == "llama":
    from llama_server import router as llm_router
else:
    from ollama import router as llm_router

from weather import router as weather_router

app.include_router(stt_router)
app.include_router(llm_router)
app.include_router(tts_router)
app.include_router(weather_router)


@app.get("/health")
def health():
    return {"status": "ok"}


# ── RAG endpoints ─────────────────────────────────────────────────────────────

@app.post("/rag/ingest")
async def rag_ingest(background_tasks: BackgroundTasks):
    """Trigger async document ingestion from memory/input/. Returns immediately."""
    from rag import ingest, INPUT_FOLDER
    background_tasks.add_task(ingest)
    return {"status": "ingesting", "folder": INPUT_FOLDER}


@app.get("/rag/status")
async def rag_status():
    """Return RAG system status: enabled flag, chunk count, collection name."""
    from rag import get_status
    return get_status()


@app.get("/rag/manifest")
def rag_manifest():
    """
    Serve assets/images/manifest.json as JSON.
    Falls back to an empty list if the file does not exist.
    """
    manifest_path = _ASSETS / "images" / "manifest.json"
    if not manifest_path.exists():
        return []
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return []



@app.get("/system-status")
async def system_status():
    import httpx
    import stt as _stt
    import tts as _tts

    # Whisper — device is resolved once at startup
    whisper_device = "GPU" if _stt._active_device == "cuda" else "CPU"

    # Kokoro — check actual ONNX session providers if model is loaded,
    # otherwise predict from what onnxruntime reports as available
    if _tts._kokoro is not None:
        active_providers = _tts._kokoro.sess.get_providers()
    else:
        active_providers = _tts._available

    def _provider_is_gpu(providers: list) -> bool:
        return any(
            kw in p for p in providers
            for kw in ("CUDA", "TensorRT", "Dml", "ROCm")
        )

    kokoro_device = "GPU" if _provider_is_gpu(active_providers) else "CPU"

    # LLM backend status — behaviour differs by LLM_BACKEND selection
    llm_device = "UNKNOWN"
    if LLM_BACKEND == "llama":
        from llama_server import LLAMA_BASE
        llm_url = LLAMA_BASE.removeprefix("http://").removeprefix("https://")
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{LLAMA_BASE}/health")
                if resp.status_code == 200 and resp.json().get("status") == "ok":
                    llm_device = "GPU"
                else:
                    llm_device = "CPU"
        except Exception:
            llm_device = "OFFLINE"
    else:
        from ollama import OLLAMA_BASE
        llm_url = OLLAMA_BASE.removeprefix("http://").removeprefix("https://")
        # Ollama — /api/ps returns running models; size_vram > 0 means GPU
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{OLLAMA_BASE}/api/ps")
                if resp.status_code == 200:
                    models = resp.json().get("models", [])
                    if models:
                        size_vram = sum(m.get("size_vram", 0) for m in models)
                        llm_device = "GPU" if size_vram > 0 else "CPU"
                    else:
                        llm_device = "IDLE"
        except Exception:
            llm_device = "OFFLINE"

    return {
        "whisper":     whisper_device,
        "kokoro":      kokoro_device,
        "llm":         llm_device,
        "llm_backend": LLM_BACKEND,
        "llm_url":     llm_url,
    }


# ── Dossier endpoint ─────────────────────────────────────────────────────────
_FRONTEND = Path(__file__).parent.parent / "frontend"
_ASSETS   = Path(__file__).parent.parent / "assets"

@app.get("/dossier/{key}")
def get_dossier(key: str):
    """Parse a dossier markdown file and return structured JSON."""
    # Sanitize key — only lowercase alphanumeric, underscores, hyphens allowed
    if not re.fullmatch(r'[a-z0-9_\-]+', key):
        raise HTTPException(status_code=400, detail="Invalid dossier key")
    path = _ASSETS / "dossier_descriptions" / f"{key}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Dossier not found")

    lines = path.read_text(encoding="utf-8").splitlines()
    meta: dict = {}
    body = ""
    for i, line in enumerate(lines):
        if line.startswith("Description of target:"):
            body = "\n".join(lines[i + 1:]).strip()
            break
        m = re.match(r'^([^:]+):\s*(.+)$', line)
        if m:
            meta[m.group(1).strip()] = m.group(2).strip()

    title = meta.pop("Name", key.replace("_", " ").title())
    return {"title": title, "body": body, "meta": meta}


# ── Serve frontend ────────────────────────────────────────────────────────────

@app.get("/")
def serve_index():
    return FileResponse(
        _FRONTEND / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

app.mount("/assets", StaticFiles(directory=_ASSETS), name="assets")
app.mount("/", StaticFiles(directory=_FRONTEND), name="frontend")
