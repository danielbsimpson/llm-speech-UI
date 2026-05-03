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
