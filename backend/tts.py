"""Async GPT-SoVITS client.

GPT-SoVITS runs as a separate local server that the user starts before this
app (see CLAUDE.md):

    python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

This module only calls ``POST /tts`` — GPT-SoVITS is strictly an external
API and is never vendored or reimplemented here. When the server is
unreachable the pipeline must stay alive and fall back to text-only replies.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

START_HINT = (
    "GPT-SoVITS server is not running — start it first:\n"
    "  python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml"
)


class TTSUnavailableError(RuntimeError):
    """GPT-SoVITS could not be reached. Continue text-only; do not crash."""


class TTSRequestError(RuntimeError):
    """GPT-SoVITS rejected one request. Safe to keep trying later segments."""


class SovitsClient:
    """Thin async wrapper around the GPT-SoVITS ``POST /tts`` endpoint."""

    def __init__(
        self,
        base_url: str,
        text_lang: str,
        prompt_lang: str,
        ref_audio_path: str,
        prompt_text: str,
    ) -> None:
        self.text_lang = text_lang
        self.prompt_lang = prompt_lang
        self.ref_audio_path = ref_audio_path
        self.prompt_text = prompt_text
        # Short connect timeout so a down server fails fast; synthesis itself
        # can legitimately take a while on slower GPUs.
        self._http = httpx.AsyncClient(
            base_url=base_url, timeout=httpx.Timeout(120.0, connect=3.0)
        )

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> Optional["SovitsClient"]:
        """Build a client from config.yaml, or None if sovits isn't configured.

        Returns None (text-only mode) when ref_audio_path / prompt_text are
        empty or still the template placeholders.
        """
        s = config.get("sovits") or {}
        ref = str(s.get("ref_audio_path") or "")
        prompt = str(s.get("prompt_text") or "")
        if not ref or not prompt or ref.startswith("<") or prompt.startswith("<"):
            logger.warning(
                "sovits.ref_audio_path / prompt_text not set in config.yaml — running text-only"
            )
            return None
        return cls(
            base_url=str(s.get("base_url", "http://127.0.0.1:9880")),
            text_lang=str(s.get("text_lang", "en")),
            prompt_lang=str(s.get("prompt_lang", "en")),
            ref_audio_path=ref,
            prompt_text=prompt,
        )

    async def synthesize(self, text: str) -> bytes:
        """Synthesize one sentence; return WAV bytes.

        Raises TTSUnavailableError when the server can't be reached and
        TTSRequestError when the server rejects this particular request.
        """
        payload = {
            "text": text,
            "text_lang": self.text_lang,
            "ref_audio_path": self.ref_audio_path,
            "prompt_text": self.prompt_text,
            "prompt_lang": self.prompt_lang,
            "media_type": "wav",
        }
        t0 = time.perf_counter()
        try:
            resp = await self._http.post("/tts", json=payload)
        except httpx.ConnectError as exc:
            raise TTSUnavailableError(START_HINT) from exc
        except httpx.TimeoutException as exc:
            raise TTSUnavailableError(
                f"GPT-SoVITS did not respond in time ({exc.__class__.__name__}). {START_HINT}"
            ) from exc
        if resp.status_code != 200:
            try:
                detail = resp.json().get("message", resp.text[:200])
            except Exception:
                detail = resp.text[:200]
            raise TTSRequestError(f"GPT-SoVITS returned {resp.status_code}: {detail}")
        wav = resp.content
        logger.info(
            "TTS ok: %d chars -> %d KiB in %.2fs",
            len(text),
            len(wav) // 1024,
            time.perf_counter() - t0,
        )
        return wav

    async def aclose(self) -> None:
        await self._http.aclose()
