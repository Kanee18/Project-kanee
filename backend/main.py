"""FastAPI app: WebSocket endpoint and pipeline orchestration only.

One WebSocket carries everything (JSON control/segments, base64 audio).
Pipeline per user message:

    user_text ──────────────────────────┐
    user_audio ── ASR ── transcript ────┤── streaming LLM ── parser ── per
                                        │   segment: TTS ── ws "segment"
    interrupt ── cancels the reply task ┘

Run from the backend/ directory:

    py -m uvicorn main:app --port 8000
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from asr import Transcriber
from llm import LLMClient
from parser import Segment, StreamingTagParser
from tts import SovitsClient, TTSRequestError, TTSUnavailableError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("main")

_BACKEND_DIR = Path(__file__).resolve().parent


class Pipeline:
    """Shared clients + a lock that serializes replies (history is shared)."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.llm = LLMClient(config)
        self.tts = SovitsClient.from_config(config)
        asr_cfg = config.get("asr") or {}
        self.asr = Transcriber(
            model_size=str(asr_cfg.get("model_size", "small")),
            device=str(asr_cfg.get("device", "cuda")),
        )
        self.reply_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = yaml.safe_load((_BACKEND_DIR / "config.yaml").read_text(encoding="utf-8"))
    app.state.pipeline = Pipeline(config)
    logger.info("backend ready (tts %s)", "on" if app.state.pipeline.tts else "off — text-only")
    yield
    if app.state.pipeline.tts is not None:
        await app.state.pipeline.tts.aclose()


app = FastAPI(lifespan=lifespan)


class Session:
    """One WebSocket connection: routes messages, owns the active reply task."""

    def __init__(self, ws: WebSocket, pipeline: Pipeline) -> None:
        self.ws = ws
        self.pipe = pipeline
        self._task: Optional[asyncio.Task] = None

    async def send(self, msg: dict[str, Any]) -> None:
        await self.ws.send_text(json.dumps(msg))

    # -- message routing ------------------------------------------------------

    async def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "user_text":
            text = str(msg.get("text") or "").strip()
            if text:
                self._start(self._reply(text))
        elif kind == "user_audio":
            self._start(self._voice_reply(str(msg.get("audio") or "")))
        elif kind == "interrupt":
            await self.cancel_reply()
            await self.send({"type": "state", "value": "idle"})
        else:
            await self.send({"type": "error", "message": f"Unknown message type {kind!r}."})

    def _start(self, coro) -> None:
        """Run a reply task; any in-flight reply is cancelled (implicit interrupt).

        The pipeline reply_lock guarantees the new task only proceeds after
        the cancelled one has finished unwinding (and released the lock).
        """
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = asyncio.create_task(self._guarded(coro))

    async def cancel_reply(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except BaseException:
                pass

    async def _guarded(self, coro) -> None:
        try:
            await coro
        except asyncio.CancelledError:
            logger.info("reply cancelled (interrupt)")
            raise
        except Exception as exc:
            logger.exception("pipeline error")
            try:
                await self.send({"type": "error", "message": str(exc)})
                await self.send({"type": "state", "value": "idle"})
            except Exception:
                pass  # socket already gone

    # -- pipeline stages ------------------------------------------------------

    async def _voice_reply(self, audio_b64: str) -> None:
        await self.send({"type": "state", "value": "thinking"})
        try:
            audio = base64.b64decode(audio_b64)
        except (binascii.Error, ValueError):
            raise ValueError("Could not decode the audio payload — try again.")
        if not audio:
            raise ValueError("The recording was empty — hold the button while you speak.")
        text = await self.pipe.asr.transcribe(audio)
        if not text:
            await self.send(
                {"type": "error", "message": "I couldn't hear anything — try speaking closer to the mic."}
            )
            await self.send({"type": "state", "value": "idle"})
            return
        await self.send({"type": "transcript", "text": text})
        await self._reply(text)

    async def _reply(self, user_text: str) -> None:
        async with self.pipe.reply_lock:
            t0 = time.perf_counter()
            await self.send({"type": "state", "value": "thinking"})
            parser = StreamingTagParser()
            seg_q: asyncio.Queue[Optional[Segment]] = asyncio.Queue()
            llm_error: Optional[Exception] = None
            n_parsed = 0

            async def produce() -> None:
                nonlocal llm_error, n_parsed
                try:
                    async for chunk in self.pipe.llm.stream_reply(user_text):
                        for seg in parser.feed(chunk):
                            n_parsed += 1
                            await seg_q.put(seg)
                    for seg in parser.finish():
                        n_parsed += 1
                        await seg_q.put(seg)
                except Exception as exc:
                    llm_error = exc
                finally:
                    await seg_q.put(None)

            async def synth_and_send() -> None:
                tts_down = self.pipe.tts is None
                first_sent = False
                while True:
                    seg = await seg_q.get()
                    if seg is None:
                        break
                    audio_b64: Optional[str] = None
                    if not tts_down:
                        try:
                            wav = await self.pipe.tts.synthesize(seg.text)
                            audio_b64 = base64.b64encode(wav).decode("ascii")
                        except TTSUnavailableError as exc:
                            tts_down = True  # stop trying for this reply
                            await self.send({"type": "error", "message": str(exc)})
                        except TTSRequestError as exc:
                            logger.warning("TTS rejected segment, continuing: %s", exc)
                    if not first_sent:
                        first_sent = True
                        await self.send({"type": "state", "value": "speaking"})
                        logger.info(
                            "first segment sent at +%.2fs (audio: %s)",
                            time.perf_counter() - t0, "yes" if audio_b64 else "no",
                        )
                    await self.send(
                        {
                            "type": "segment",
                            "text": seg.text,
                            "emotion": seg.emotion,
                            "gesture": seg.gesture,
                            "audio": audio_b64,
                        }
                    )

            await asyncio.gather(produce(), synth_and_send())
            if llm_error is not None:
                raise llm_error
            await self.send({"type": "reply_done"})
            await self.send({"type": "state", "value": "idle"})
            logger.info("reply done: %d segment(s) in %.2fs", n_parsed, time.perf_counter() - t0)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    session = Session(websocket, websocket.app.state.pipeline)
    logger.info("websocket connected")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await session.send({"type": "error", "message": "Invalid JSON message."})
                continue
            await session.handle(msg)
    except WebSocketDisconnect:
        logger.info("websocket disconnected")
    finally:
        await session.cancel_reply()
