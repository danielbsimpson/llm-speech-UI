import os
from pathlib import Path

from fastapi import FastAPI
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

app.include_router(stt_router)
app.include_router(llm_router)
app.include_router(tts_router)


@app.get("/health")
def health():
    return {"status": "ok"}



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


# ── Serve frontend ────────────────────────────────────────────────────────────
_FRONTEND = Path(__file__).parent.parent / "frontend"

@app.get("/")
def serve_index():
    return FileResponse(
        _FRONTEND / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

app.mount("/", StaticFiles(directory=_FRONTEND), name="frontend")
