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
import os
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from asr import Transcriber
from game_watcher import GameWatcher
from llm import LLMClient, LOCAL_UID
from math_solver import solve as solve_math
from parser import Segment, StreamingTagParser
from tts import SovitsClient, TTSRequestError, TTSUnavailableError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("main")

_BACKEND_DIR = Path(__file__).resolve().parent

# --- optional Firebase auth (protects the public/tunnelled backend) ----------
# Drop a Firebase service-account JSON at backend/serviceAccount.json to require
# a valid Firebase ID token from a beta-approved account on every WS connect.
#
# Without that file the backend is UNAUTHENTICATED, which is only safe on a
# private machine. It therefore FAILS CLOSED: an unauthenticated backend refuses
# every connection unless you explicitly opt in with KANEE_ALLOW_NO_AUTH=1
# (local dev only — never when the port is exposed or tunnelled). This stops an
# accidentally-exposed backend from being an open, billable LLM/ASR relay.
_SA_PATH = _BACKEND_DIR / "serviceAccount.json"
_ALLOW_NO_AUTH = os.getenv("KANEE_ALLOW_NO_AUTH", "").strip().lower() in {"1", "true", "yes", "on"}
_AUTH_ENABLED = False
_fb_auth = None
_fb_fs = None
if _SA_PATH.exists():
    try:
        import firebase_admin
        from firebase_admin import auth as _fb_auth_mod
        from firebase_admin import credentials
        from firebase_admin import firestore as _fb_fs_mod

        firebase_admin.initialize_app(credentials.Certificate(str(_SA_PATH)))
        _fb_auth = _fb_auth_mod
        _fb_fs = _fb_fs_mod.client()
        _AUTH_ENABLED = True
        logger.info("backend auth: ON — Firebase token + beta access required")
    except Exception as exc:  # noqa: BLE001
        logger.warning("backend auth init failed (%s)", exc)

if not _AUTH_ENABLED:
    if _ALLOW_NO_AUTH:
        logger.warning(
            "backend auth: OFF (KANEE_ALLOW_NO_AUTH set) — WS is OPEN. "
            "Local dev only; do NOT expose or tunnel this port."
        )
    else:
        logger.warning(
            "backend auth: OFF and not opted in — refusing all WS connections. "
            "Add backend/serviceAccount.json to require sign-in, or set "
            "KANEE_ALLOW_NO_AUTH=1 for local-only dev."
        )


async def _authenticate(ws: WebSocket) -> Optional[str]:
    """Consume the client's first message (the auth handshake) and return the
    authenticated user id, or None if the connection must be dropped.

    - Auth enabled: require a valid Firebase ID token from a beta-approved
      account; returns the Firebase uid.
    - Auth disabled + KANEE_ALLOW_NO_AUTH: returns LOCAL_UID (open dev mode).
    - Auth disabled + not opted in: rejects (fail closed).

    Note: betaAccess is re-checked here on EVERY connect, so flipping a user's
    betaAccess to false in Firestore is an immediate kill-switch.
    """
    async def _reject(message: str, code: int) -> None:
        try:
            await ws.send_text(json.dumps({"type": "error", "message": message}))
            await ws.close(code=code)
        except Exception:
            pass

    try:
        msg = json.loads(await ws.receive_text())
    except Exception:
        await _reject("Invalid auth handshake.", 4401)
        return None

    if not _AUTH_ENABLED:
        if _ALLOW_NO_AUTH:
            return LOCAL_UID
        await _reject("This server isn't configured for sign-in.", 4401)
        return None

    token = msg.get("token") if isinstance(msg, dict) else None
    if not isinstance(msg, dict) or msg.get("type") != "auth" or not token:
        await _reject("Sign-in required to chat.", 4401)
        return None
    try:
        decoded = await asyncio.to_thread(_fb_auth.verify_id_token, token)
    except Exception:
        await _reject("Your session is invalid — please sign in again.", 4401)
        return None

    uid = decoded.get("uid")
    try:
        snap = await asyncio.to_thread(lambda: _fb_fs.collection("users").document(uid).get())
        if not (snap.exists and (snap.to_dict() or {}).get("betaAccess") is True):
            await _reject("Your account doesn't have beta access yet.", 4403)
            return None
    except Exception as exc:  # noqa: BLE001
        # Token was valid; don't lock the user out over a transient Firestore error.
        logger.warning("beta-access check failed for %s: %s", uid, exc)
    logger.info("ws authenticated: %s", uid)
    return uid


# -- abuse limits (per WS connection) -----------------------------------------
_MAX_TEXT_CHARS = 4000               # reject a chat message longer than this
_MAX_AUDIO_BYTES = 8 * 1024 * 1024   # 8 MiB cap on a decoded voice recording
_RL_RATE = 1.0                       # sustained user messages allowed per second
_RL_BURST = 6.0                      # token-bucket size (short bursts)


class UserError(Exception):
    """An error whose message is safe AND useful to show the user verbatim.
    Everything else is reported to the client as a generic message (no internal
    detail leak); the full traceback goes to the server log only."""


class Pipeline:
    """Shared clients + a lock that serializes replies across the process."""

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

    def __init__(self, ws: WebSocket, pipeline: Pipeline, user_id: str) -> None:
        self.ws = ws
        self.pipe = pipeline
        self.uid = user_id  # scopes this connection's history/memory (see llm.py)
        self._task: Optional[asyncio.Task] = None
        self._game_events: deque[tuple[str, str, Optional[float]]] = deque(maxlen=3)
        # Per-connection token bucket: refill _RL_RATE/s up to _RL_BURST.
        self._tokens = _RL_BURST
        self._last_refill = time.monotonic()

    def _rate_ok(self) -> bool:
        """True if this connection may start another costly (LLM/ASR) request."""
        now = time.monotonic()
        self._tokens = min(_RL_BURST, self._tokens + (now - self._last_refill) * _RL_RATE)
        self._last_refill = now
        if self._tokens < 1.0:
            return False
        self._tokens -= 1.0
        return True

    async def send(self, msg: dict[str, Any]) -> None:
        await self.ws.send_text(json.dumps(msg))

    # -- message routing ------------------------------------------------------

    async def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "user_text":
            if not self._rate_ok():
                await self.send({"type": "error", "message": "Slow down a moment — too many messages."})
                return
            text = str(msg.get("text") or "").strip()
            if len(text) > _MAX_TEXT_CHARS:
                await self.send({"type": "error", "message": "That message is too long — keep it shorter."})
                return
            if text:
                self._game_events.clear()  # the user is talking — drop stale game banter
                self._start(self._reply(text))
        elif kind == "user_audio":
            if not self._rate_ok():
                await self.send({"type": "error", "message": "Slow down a moment — too many messages."})
                return
            self._game_events.clear()
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
        except UserError as exc:
            # Safe, actionable message — show it to the user as-is.
            try:
                await self.send({"type": "error", "message": str(exc)})
                await self.send({"type": "state", "value": "idle"})
            except Exception:
                pass  # socket already gone
        except Exception:
            # Unexpected: log the full detail server-side, tell the user nothing
            # internal (no paths, provider errors, or stack hints leak out).
            logger.exception("pipeline error")
            try:
                await self.send(
                    {"type": "error", "message": "Something went wrong on my end — try again in a moment."}
                )
                await self.send({"type": "state", "value": "idle"})
            except Exception:
                pass  # socket already gone

    # -- pipeline stages ------------------------------------------------------

    async def _voice_reply(self, audio_b64: str) -> None:
        await self.send({"type": "state", "value": "thinking"})
        # Reject oversized payloads before spending work decoding them (base64 is
        # ~4/3 the byte size).
        if len(audio_b64) > _MAX_AUDIO_BYTES * 4 // 3 + 1024:
            raise UserError("That recording is too large — keep it under a few seconds.")
        try:
            audio = base64.b64decode(audio_b64)
        except (binascii.Error, ValueError):
            raise UserError("Could not decode the audio payload — try again.")
        if not audio:
            raise UserError("The recording was empty — hold the button while you speak.")
        if len(audio) > _MAX_AUDIO_BYTES:
            raise UserError("That recording is too large — keep it under a few seconds.")
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
            # Arithmetic question → drive the math-answer animation + hologram.
            math = solve_math(user_text)
            if math is not None:
                logger.info("math: %s = %s", math["expr"], math["answer"])
                await self.send({"type": "math", "expr": math["expr"], "answer": math["answer"]})
            await self._stream_segments(self.pipe.llm.stream_reply(user_text, self.uid), t0)

    async def comment_on_game(self, kind: str, game: str, minutes: Optional[float] = None) -> None:
        """Proactively comment on the game the user is playing (no thinking
        state, no math)."""
        cue = self._game_cue(kind, game, minutes)
        logger.info("game comment: %s %s -> asking LLM to react", kind, game)
        async with self.pipe.reply_lock:
            t0 = time.perf_counter()
            await self._stream_segments(self.pipe.llm.stream_comment(cue, self.uid), t0)

    @staticmethod
    def _game_cue(kind: str, game: str, minutes: Optional[float]) -> str:
        if kind == "start":
            return f"The user just opened and started playing the game '{game}'."
        if kind == "ambient":
            return f"The user is still playing '{game}' right now."
        if kind == "stop":
            if minutes is not None and minutes < 2:
                return f"The user opened '{game}' but closed it again almost immediately (under two minutes)."
            if minutes is not None and minutes >= 90:
                return f"The user just closed '{game}' after a very long session (about {minutes / 60:.1f} hours)."
            if minutes is not None:
                return f"The user just closed '{game}' after about {minutes:.0f} minutes of playing."
            return f"The user just closed '{game}'."
        return f"The user is playing '{game}'."

    async def _stream_segments(self, token_iter, t0: float) -> None:
        """Parse an LLM token stream into tagged segments, synth each via TTS,
        and stream them to the client. Shared by replies and game comments."""
        parser = StreamingTagParser()
        seg_q: asyncio.Queue[Optional[Segment]] = asyncio.Queue()
        llm_error: Optional[Exception] = None
        n_parsed = 0

        async def produce() -> None:
            nonlocal llm_error, n_parsed
            try:
                async for chunk in token_iter:
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

    def maybe_comment(self, kind: str, game: str, minutes: Optional[float] = None) -> None:
        """Queue a game comment (called by the GameWatcher). Drained only when
        idle, so it never preempts a real reply — and an open-then-close fires
        both lines in order. A user message clears the queue."""
        self._game_events.append((kind, game, minutes))
        if self._task is None or self._task.done():
            self._start(self._drain_game_events())

    async def _drain_game_events(self) -> None:
        while self._game_events:
            kind, game, minutes = self._game_events.popleft()
            await self.comment_on_game(kind, game, minutes)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    logger.info("websocket connected")
    uid = await _authenticate(websocket)
    if uid is None:
        logger.info("websocket rejected (auth)")
        return
    session = Session(websocket, websocket.app.state.pipeline, uid)
    # Proactive game comments watch the HOST machine's foreground process, so
    # only run them in local single-user mode — with remote authenticated users
    # this would leak the host's activity (what the owner is playing) to clients.
    watcher = GameWatcher(session.maybe_comment)
    watch_games = not _AUTH_ENABLED
    if watch_games:
        watcher.start()
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
        if watch_games:
            await watcher.stop()
        await session.cancel_reply()
