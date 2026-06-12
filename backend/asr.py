"""Faster-Whisper ASR wrapper.

The model is loaded lazily on the first voice message (loading takes seconds
and text-only users never pay for it), on CUDA with automatic CPU fallback.
Transcription runs in a worker thread — never on the event loop.
"""

from __future__ import annotations

import asyncio
import io
import logging
import threading
import time

logger = logging.getLogger(__name__)


class Transcriber:
    """Async facade over a lazily-created faster-whisper model."""

    def __init__(self, model_size: str = "small", device: str = "cuda") -> None:
        self.model_size = model_size
        self.device = device
        self._model = None
        self._model_lock = threading.Lock()

    def _ensure_model(self):
        """Create the Whisper model on first use (thread-safe, blocking)."""
        with self._model_lock:
            if self._model is not None:
                return self._model
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError(
                    "faster-whisper is not installed — run: pip install -r requirements.txt"
                ) from exc
            t0 = time.perf_counter()
            device = self.device
            compute = "float16" if device == "cuda" else "int8"
            try:
                model = WhisperModel(self.model_size, device=device, compute_type=compute)
            except Exception as exc:
                if device == "cpu":
                    raise
                logger.warning("Whisper init on %s failed (%s) — falling back to CPU", device, exc)
                device = "cpu"
                model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
            logger.info(
                "Whisper '%s' loaded on %s in %.1fs", self.model_size, device,
                time.perf_counter() - t0,
            )
            self._model = model
            return model

    async def transcribe(self, audio: bytes) -> str:
        """Transcribe an encoded audio blob (webm/wav/ogg...) to English text."""

        def run() -> str:
            model = self._ensure_model()
            t0 = time.perf_counter()
            # faster-whisper decodes file-like objects via PyAV, so the
            # browser's webm/opus blobs work directly.
            segments, info = model.transcribe(io.BytesIO(audio), language="en", vad_filter=True)
            text = " ".join(s.text.strip() for s in segments).strip()
            logger.info(
                "ASR: %.1fs of audio -> %r in %.2fs",
                info.duration, text[:60], time.perf_counter() - t0,
            )
            return text

        return await asyncio.to_thread(run)
