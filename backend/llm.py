"""Streaming LLM client: provider selection, system prompt, conversation memory.

Yields raw reply chunks (which still contain the emotion/gesture tags);
turning the stream into tagged sentence segments is parser.py's job.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(_BACKEND_DIR / ".env")


class LLMClient:
    """Streams tagged character replies from the configured LLM provider."""

    def __init__(self, config: dict[str, Any]) -> None:
        llm_cfg = config["llm"]
        self.provider: str = llm_cfg.get("provider", "anthropic")
        self.model: str = llm_cfg["model"]
        self.max_tokens: int = int(llm_cfg.get("max_tokens", 1024))
        self.max_history_turns: int = int(llm_cfg.get("max_history_turns", 30))
        self.history_file: Path = _BACKEND_DIR / llm_cfg.get("history_file", "chat_history.json")
        self.system_prompt: str = config["character"]["system_prompt"]
        self.history: list[dict[str, str]] = self._load_history()

        if self.provider == "anthropic":
            import anthropic

            self._client = anthropic.AsyncAnthropic()
        elif self.provider == "openai":
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI()
        elif self.provider == "google":
            from google import genai

            # Reads GEMINI_API_KEY (or GOOGLE_API_KEY) from the environment.
            self._client = genai.Client()
        else:
            raise ValueError(
                f"Unknown llm.provider {self.provider!r} in config.yaml — "
                "use 'anthropic', 'openai', or 'google'"
            )
        logger.info("LLM client ready: provider=%s model=%s", self.provider, self.model)

    async def stream_reply(self, user_text: str) -> AsyncIterator[str]:
        """Send one user message; yield the reply as raw text chunks.

        The user turn is added to history immediately and rolled back if the
        request fails, so a retry starts from a clean state. The assistant
        turn (with tags intact, to keep the persona consistent) is appended
        and persisted once the stream completes.
        """
        self.history.append({"role": "user", "content": user_text})
        t0 = time.perf_counter()
        first_chunk_at: float | None = None
        parts: list[str] = []
        streamers = {
            "anthropic": self._stream_anthropic,
            "openai": self._stream_openai,
            "google": self._stream_google,
        }
        stream = streamers[self.provider]()
        try:
            async for chunk in stream:
                if first_chunk_at is None:
                    first_chunk_at = time.perf_counter() - t0
                    logger.info("first LLM token after %.2fs", first_chunk_at)
                parts.append(chunk)
                yield chunk
        except (asyncio.CancelledError, GeneratorExit):
            # Interrupted mid-reply: keep whatever was already generated so
            # the conversation stays coherent; drop the turn if nothing came.
            if parts:
                self.history.append({"role": "assistant", "content": "".join(parts)})
                self._trim_history()
                self._save_history()
            else:
                self.history.pop()
            raise
        except Exception:
            self.history.pop()
            raise
        reply = "".join(parts)
        self.history.append({"role": "assistant", "content": reply})
        self._trim_history()
        self._save_history()
        logger.info("LLM reply complete: %d chars in %.2fs", len(reply), time.perf_counter() - t0)

    # -- providers ----------------------------------------------------------

    async def _stream_anthropic(self) -> AsyncIterator[str]:
        async with self._client.messages.stream(
            model=self.model,
            max_tokens=self.max_tokens,
            system=[
                {
                    "type": "text",
                    "text": self.system_prompt,
                    # The system prompt is the stable prefix — let it cache.
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=list(self.history),
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def _stream_openai(self) -> AsyncIterator[str]:
        stream = await self._client.chat.completions.create(
            model=self.model,
            max_tokens=self.max_tokens,
            stream=True,
            messages=[{"role": "system", "content": self.system_prompt}, *self.history],
        )
        async for event in stream:
            if event.choices and event.choices[0].delta and event.choices[0].delta.content:
                yield event.choices[0].delta.content

    async def _stream_google(self) -> AsyncIterator[str]:
        from google.genai import types

        # Gemini uses role "model" for the assistant and nests text under
        # "parts"; the system prompt is passed separately via config.
        contents = [
            {
                "role": "model" if m["role"] == "assistant" else "user",
                "parts": [{"text": m["content"]}],
            }
            for m in self.history
        ]
        stream = await self._client.aio.models.generate_content_stream(
            model=self.model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=self.system_prompt,
                max_output_tokens=self.max_tokens,
            ),
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text

    # -- history ------------------------------------------------------------

    def _trim_history(self) -> None:
        limit = self.max_history_turns * 2  # one turn = user + assistant message
        if len(self.history) > limit:
            self.history = self.history[-limit:]

    def _load_history(self) -> list[dict[str, str]]:
        if not self.history_file.exists():
            return []
        try:
            data = json.loads(self.history_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                logger.info("loaded %d history messages from %s", len(data), self.history_file.name)
                return data
            logger.warning("%s is not a list — starting with empty history", self.history_file.name)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "could not read %s (%s) — starting with empty history", self.history_file.name, exc
            )
        return []

    def _save_history(self) -> None:
        try:
            self.history_file.write_text(
                json.dumps(self.history, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("could not save chat history: %s", exc)
