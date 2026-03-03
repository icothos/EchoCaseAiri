"""
edge-tts OpenAI-compatible TTS server
실행: python edge-tts-server.py
기본 포트: 5050 (EDGE_TTS_PORT 환경변수로 변경 가능)

ThreadPoolExecutor + 새 asyncio 루프로 uvicorn event loop와 완전 분리
"""

import io
import os
import sys
import asyncio
import tempfile
import traceback
import concurrent.futures

import edge_tts
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="edge-tts OpenAI-compatible server")

# CORS: Airi(localhost:5173)에서 요청 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PORT = int(os.environ.get("EDGE_TTS_PORT", 5050))

# 전용 thread pool — 각 요청마다 독립 thread에서 새 event loop 실행
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

VOICE_MAP = {
    "alloy":   "ko-KR-SunHiNeural",
    "echo":    "ko-KR-InJoonNeural",
    "fable":   "ko-KR-HyunsuMultilingualNeural",
    "onyx":    "ko-KR-InJoonNeural",
    "nova":    "ko-KR-SunHiNeural",
    "shimmer": "ko-KR-SunHiNeural",
}

class TTSRequest(BaseModel):
    model: str = "tts-1"
    input: str
    voice: str = "ko-KR-SunHiNeural"
    response_format: Optional[str] = "mp3"
    speed: Optional[float] = 1.0


def _edge_tts_in_new_loop(text: str, voice: str, rate_str: str) -> bytes:
    """
    완전히 새로운 asyncio event loop를 생성해 edge_tts 실행.
    Windows에서 ProactorEventLoop 충돌 방지를 위해 SelectorEventLoop 강제 사용.
    """
    async def _run():
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp3")
        os.close(tmp_fd)
        try:
            communicate = edge_tts.Communicate(text, voice, rate=rate_str)
            await communicate.save(tmp_path)
            with open(tmp_path, "rb") as f:
                return f.read()
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    # Windows: ProactorEventLoop 충돌 방지 → SelectorEventLoop 강제 사용
    if sys.platform == "win32":
        loop = asyncio.SelectorEventLoop()
    else:
        loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [{"id": "tts-1", "object": "model"}],
    }


@app.post("/v1/audio/speech")
async def text_to_speech(req: TTSRequest):
    voice = req.voice if "-" in req.voice else VOICE_MAP.get(req.voice, "ko-KR-SunHiNeural")

    speed = req.speed if req.speed is not None else 1.0
    rate_pct = int((speed - 1.0) * 100)
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"

    print(f"[TTS] voice={voice} rate={rate_str} text={req.input[:50]!r}", flush=True)

    try:
        loop = asyncio.get_event_loop()
        audio_bytes = await loop.run_in_executor(
            _executor,
            _edge_tts_in_new_loop,
            req.input,
            voice,
            rate_str,
        )
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        raise HTTPException(status_code=500, detail=str(e))

    if not audio_bytes:
        raise HTTPException(status_code=500, detail="edge-tts returned empty audio")

    print(f"[TTS] OK: {len(audio_bytes)} bytes", flush=True)
    media_type = "audio/mpeg" if req.response_format in ("mp3", None) else f"audio/{req.response_format}"
    return Response(content=audio_bytes, media_type=media_type)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    print(f"[edge-tts server] http://localhost:{PORT}/v1/")
    print("  한국어 음성: ko-KR-SunHiNeural / ko-KR-InJoonNeural / ko-KR-HyunsuMultilingualNeural")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
