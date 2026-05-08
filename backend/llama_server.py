"""backend/llama_server.py — Streaming chat relay to llama-server (OpenAI-compatible).

Re-encodes the OpenAI SSE stream from llama-server as Ollama-style NDJSON so the
frontend token-parsing logic is identical for both backends.  Switch between this
and ollama.py by setting LLM_BACKEND=llama in your .env file.
"""

import json
import os

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/chat", tags=["llama"])

LLAMA_BASE    = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")
DEFAULT_MODEL = os.getenv("LLAMA_MODEL", "llama3.1-8b")
SYSTEM_PROMPT = os.getenv(
    "LLAMA_SYSTEM_PROMPT",
    "You are S.T.A.R.L.I.N.G. (Speech\u2011Triggered Autonomous Reasoning & Local Intelligence Node Generator), "
    "a highly capable local AI assistant. Be concise, precise, and direct. Avoid unnecessary pleasantries.",
)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = DEFAULT_MODEL
    temperature: float = float(os.getenv("LLAMA_TEMPERATURE", "0.7"))


async def _stream_as_ndjson(payload: dict):
    """Stream from llama-server (OpenAI SSE) and re-encode as Ollama-style NDJSON.

    This means the frontend token-parsing path (JSON.parse(line)?.message?.content)
    works without modification when LLM_BACKEND is switched to 'llama'.
    After the done sentinel, emits a {"metrics": {...}} line with timings and token
    usage so the frontend can display performance stats without a separate request.
    """
    last_chunk: dict = {}  # final chunk before [DONE] — carries timings + usage

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{LLAMA_BASE}/v1/chat/completions", json=payload
        ) as resp:
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="llama-server error")
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    yield json.dumps({"message": {"content": ""}, "done": True}) + "\n"
                    # Emit metrics line using timings + usage captured from final chunk
                    if last_chunk:
                        metrics: dict = {}
                        timings = last_chunk.get("timings", {})
                        usage   = last_chunk.get("usage",   {})
                        if timings:
                            metrics.update({
                                "prompt_n":             timings.get("prompt_n"),
                                "prompt_per_second":    timings.get("prompt_per_second"),
                                "predicted_n":          timings.get("predicted_n"),
                                "predicted_per_second": timings.get("predicted_per_second"),
                                "predicted_ms":         timings.get("predicted_ms"),
                            })
                        if usage:
                            metrics["prompt_tokens"]     = usage.get("prompt_tokens")
                            metrics["completion_tokens"] = usage.get("completion_tokens")
                        if metrics:
                            yield json.dumps({"metrics": metrics}) + "\n"
                    return
                try:
                    chunk = json.loads(data_str)
                    # Track every chunk — the stop chunk carries timings + usage
                    if chunk.get("choices", [{}])[0].get("finish_reason") == "stop":
                        last_chunk = chunk
                    content = chunk["choices"][0]["delta"].get("content", "")
                    if content:
                        yield json.dumps({"message": {"content": content}, "done": False}) + "\n"
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue


@router.get("/context-limit")
async def context_limit():
    """Return the model's configured context window size from llama-server /props."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{LLAMA_BASE}/props")
            if resp.status_code == 200:
                data = resp.json()
                return {"n_ctx": data.get("n_ctx")}
    except Exception:
        pass
    return {"n_ctx": None}


@router.post("/")
async def chat(req: ChatRequest):
    messages = [m.model_dump() for m in req.messages]
    if not messages or messages[0].get("role") != "system":
        messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    payload = {
        "model":       req.model,
        "messages":    messages,
        "temperature": req.temperature,
        "stream":      True,
    }
    return StreamingResponse(_stream_as_ndjson(payload), media_type="application/x-ndjson")
