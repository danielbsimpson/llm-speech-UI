"""backend/ollama.py — Streaming chat relay to the local Ollama API."""

import os
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/chat", tags=["ollama"])

OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
SYSTEM_PROMPT = os.getenv(
    "OLLAMA_SYSTEM_PROMPT",
    "You are JARVIS, a highly capable AI assistant created to serve. Be concise, precise, and direct. Avoid unnecessary pleasantries.",
)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = DEFAULT_MODEL
    temperature: float = float(os.getenv("OLLAMA_TEMPERATURE", "0.7"))


async def _stream_ollama(payload: dict):
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{OLLAMA_BASE}/api/chat", json=payload
        ) as resp:
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="Ollama error")
            async for chunk in resp.aiter_bytes():
                yield chunk


@router.post("/")
async def chat(req: ChatRequest):
    messages = [m.model_dump() for m in req.messages]
    # Prepend system prompt if the first message isn't already a system message
    if not messages or messages[0].get("role") != "system":
        messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    payload = {
        "model": req.model,
        "messages": messages,
        "options": {"temperature": req.temperature},
        "stream": True,
    }
    return StreamingResponse(_stream_ollama(payload), media_type="application/x-ndjson")
