from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="S.T.A.R.L.I.N.G. Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from stt import router as stt_router
from ollama import router as ollama_router
from tts import router as tts_router

app.include_router(stt_router)
app.include_router(ollama_router)
app.include_router(tts_router)


@app.get("/health")
def health():
    return {"status": "ok"}



@app.get("/system-status")
async def system_status():
    import httpx
    import stt as _stt
    import tts as _tts
    from ollama import OLLAMA_BASE

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

    # Ollama — /api/ps returns running models; size_vram > 0 means GPU
    ollama_device = "UNKNOWN"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/ps")
            if resp.status_code == 200:
                models = resp.json().get("models", [])
                if models:
                    size_vram = sum(m.get("size_vram", 0) for m in models)
                    ollama_device = "GPU" if size_vram > 0 else "CPU"
                else:
                    ollama_device = "IDLE"
    except Exception:
        ollama_device = "OFFLINE"

    return {
        "whisper": whisper_device,
        "kokoro": kokoro_device,
        "ollama": ollama_device,
    }
