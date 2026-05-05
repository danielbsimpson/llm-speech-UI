# backend/tts.py — Text-to-Speech via Kokoro TTS (kokoro-onnx v0.5)
# Model files (~300 MB total) are downloaded once by: python scripts/download_models.py
from __future__ import annotations

import io
import logging
import os
from pathlib import Path

import onnxruntime as _ort
import soundfile as sf
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response
from kokoro_onnx import Kokoro
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(prefix="/synthesize", tags=["tts"])

# ── Log active ONNX provider at import time so it shows in server startup output ─
_available = _ort.get_available_providers()
# Default to DmlExecutionProvider (DirectML/GPU) if available and env not overridden.
# kokoro-onnx only activates GPU automatically for onnxruntime-gpu; with
# onnxruntime-directml the ONNX_PROVIDER env var must be set explicitly.
_GPU_PROVIDERS = ("CUDAExecutionProvider", "TensorrtExecutionProvider",
                  "ROCMExecutionProvider", "DmlExecutionProvider")
_default_provider = next((p for p in _GPU_PROVIDERS if p in _available), None)
_onnx_provider = os.getenv("ONNX_PROVIDER", _default_provider)
if _onnx_provider:
    log.info("Kokoro ONNX provider: %s", _onnx_provider)
else:
    log.info("Kokoro ONNX provider (auto): %s — set ONNX_PROVIDER to override", _available[0])

# ── Model file paths ───────────────────────────────────────────────────────────
_MODEL_DIR   = Path(__file__).parent.parent / "models"
_ONNX_PATH   = _MODEL_DIR / "kokoro-v1.0.onnx"
_VOICES_PATH = _MODEL_DIR / "voices-v1.0.bin"

# ── Lazy singleton — loaded on first request ───────────────────────────────────
_kokoro: Kokoro | None = None
_gpu_failed: bool = False  # set True after a GPU inference error; forces CPU reload


def _build_kokoro(provider: str | None) -> Kokoro:
    """Instantiate Kokoro, overriding ONNX_PROVIDER if needed."""
    if provider is not None:
        os.environ["ONNX_PROVIDER"] = provider
    elif "ONNX_PROVIDER" in os.environ:
        del os.environ["ONNX_PROVIDER"]
    k = Kokoro(str(_ONNX_PATH), str(_VOICES_PATH))
    log.info("Kokoro TTS ready — session providers: %s", k.sess.get_providers())
    return k


def _get_kokoro() -> Kokoro:
    global _kokoro, _gpu_failed
    if _kokoro is None:
        if not _ONNX_PATH.exists() or not _VOICES_PATH.exists():
            raise RuntimeError(
                "Kokoro model files not found in models/. "
                "Run: python scripts/download_models.py"
            )
        log.info("Loading Kokoro TTS model (first request)\u2026")
        provider = None if _gpu_failed else _onnx_provider
        _kokoro = _build_kokoro(provider)
    return _kokoro


# ── Curated voice list (A/B grade English voices) ─────────────────────────────
VOICES = [
    # American English — Female
    {"id": "af_heart",    "label": "Heart (US ♀)",    "lang": "en-us"},
    {"id": "af_bella",    "label": "Bella (US ♀)",    "lang": "en-us"},
    {"id": "af_nicole",   "label": "Nicole (US ♀)",   "lang": "en-us"},
    {"id": "af_sarah",    "label": "Sarah (US ♀)",    "lang": "en-us"},
    {"id": "af_nova",     "label": "Nova (US ♀)",     "lang": "en-us"},
    {"id": "af_aoede",    "label": "Aoede (US ♀)",    "lang": "en-us"},
    # American English — Male
    {"id": "am_fenrir",   "label": "Fenrir (US ♂)",   "lang": "en-us"},
    {"id": "am_michael",  "label": "Michael (US ♂)",  "lang": "en-us"},
    {"id": "am_puck",     "label": "Puck (US ♂)",     "lang": "en-us"},
    {"id": "am_echo",     "label": "Echo (US ♂)",     "lang": "en-us"},
    # British English — Female
    {"id": "bf_emma",     "label": "Emma (GB ♀)",     "lang": "en-gb"},
    {"id": "bf_isabella", "label": "Isabella (GB ♀)", "lang": "en-gb"},
    {"id": "bf_alice",    "label": "Alice (GB ♀)",    "lang": "en-gb"},
    # British English — Male
    {"id": "bm_george",   "label": "George (GB ♂)",   "lang": "en-gb"},
    {"id": "bm_fable",    "label": "Fable (GB ♂)",    "lang": "en-gb"},
    {"id": "bm_daniel",   "label": "Daniel (GB ♂)",   "lang": "en-gb"},
]

_VOICE_MAP = {v["id"]: v for v in VOICES}


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/voices")
def list_voices():
    """Return the list of available Kokoro voices."""
    return JSONResponse(content=VOICES)


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@router.post("/")
async def synthesize(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty")
    if req.voice not in _VOICE_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown voice '{req.voice}'")
    if not (0.25 <= req.speed <= 4.0):
        raise HTTPException(status_code=400, detail="speed must be 0.25–4.0")

    try:
        kokoro = _get_kokoro()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        lang = _VOICE_MAP[req.voice]["lang"]
        try:
            samples, sample_rate = kokoro.create(
                req.text, voice=req.voice, speed=req.speed, lang=lang
            )
        except Exception as gpu_exc:
            global _kokoro, _gpu_failed
            if _gpu_failed:
                raise  # already on CPU — nothing left to try
            log.warning(
                "Kokoro GPU inference failed (%s) — reloading on CPUExecutionProvider.",
                gpu_exc,
            )
            _gpu_failed = True
            _kokoro = None  # force reload on next _get_kokoro() call
            kokoro = _get_kokoro()  # rebuilds with CPUExecutionProvider
            samples, sample_rate = kokoro.create(
                req.text, voice=req.voice, speed=req.speed, lang=lang
            )
        buf = io.BytesIO()
        sf.write(buf, samples, sample_rate, format="WAV")
        return Response(content=buf.getvalue(), media_type="audio/wav")
    except Exception as exc:
        log.exception("TTS synthesis failed")
        raise HTTPException(status_code=500, detail=f"Synthesis error: {exc}")
