# backend/stt.py — Speech-to-Text via faster-whisper
# Uncomment and configure once faster-whisper is installed:
#   pip install faster-whisper

# from fastapi import APIRouter, UploadFile, File, HTTPException
# from faster_whisper import WhisperModel
# import tempfile, os

# router = APIRouter(prefix="/transcribe", tags=["stt"])

# model = WhisperModel("base", device="cuda", compute_type="float16")

# @router.post("/")
# async def transcribe(audio: UploadFile = File(...)):
#     if audio.content_type not in ("audio/webm", "audio/wav", "audio/ogg"):
#         raise HTTPException(status_code=415, detail="Unsupported audio format")
#     with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
#         tmp.write(await audio.read())
#         tmp_path = tmp.name
#     try:
#         segments, _ = model.transcribe(tmp_path, language="en")
#         transcript = " ".join(seg.text for seg in segments).strip()
#     finally:
#         os.remove(tmp_path)
#     return {"transcript": transcript}
