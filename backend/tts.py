# backend/tts.py — Text-to-Speech via Kokoro TTS
# Uncomment and configure once kokoro-onnx is installed:
#   pip install kokoro-onnx

# from fastapi import APIRouter, HTTPException
# from fastapi.responses import Response
# from pydantic import BaseModel
# from kokoro_onnx import Kokoro
# import numpy as np, io, soundfile as sf

# router = APIRouter(prefix="/synthesize", tags=["tts"])

# kokoro = Kokoro("kokoro-v0_19.onnx", "voices.bin")

# class TTSRequest(BaseModel):
#     text: str
#     voice: str = "af"
#     speed: float = 1.0

# @router.post("/")
# async def synthesize(req: TTSRequest):
#     if not req.text.strip():
#         raise HTTPException(status_code=400, detail="Text must not be empty")
#     samples, sample_rate = kokoro.create(req.text, voice=req.voice, speed=req.speed)
#     buf = io.BytesIO()
#     sf.write(buf, samples, sample_rate, format="WAV")
#     return Response(content=buf.getvalue(), media_type="audio/wav")
