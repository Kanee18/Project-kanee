"""Streaming LLM client: provider selection, system prompt, conversation memory.

Yields raw reply chunks (which still contain the emotion/gesture tags);
turning the stream into tagged sentence segments is parser.py's job.
"""

from __future__ import annotations

import asyncio
import difflib
import json
import logging
import re
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

        # Long-term "key facts" memory: durable facts about the user, distilled
        # from past conversations and injected into the system prompt so she
        # remembers across sessions even after old turns scroll out of history.
        self.memory_file: Path = _BACKEND_DIR / llm_cfg.get("memory_file", "user_memory.json")
        self.max_memory_facts: int = int(llm_cfg.get("max_memory_facts", 50))
        self.memory: list[str] = self._load_memory()
        self._memory_lock = asyncio.Lock()
        self._bg_tasks: set[asyncio.Task[Any]] = set()
        self._turn_note = ""  # transient per-turn directive injected into the system prompt
        # Materialize the file right away so it's visibly present and starts
        # populating as facts are learned (rather than appearing only on the
        # first successful extraction).
        if not self.memory_file.exists():
            self._save_memory()

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
        # Detect a repeated question (vs. prior turns) BEFORE appending this one,
        # so she can tease the user for asking the same thing again.
        self._turn_note = self._repeat_note(user_text)
        self.history.append({"role": "user", "content": user_text})
        t0 = time.perf_counter()
        first_chunk_at: float | None = None
        parts: list[str] = []
        streamers = {
            "anthropic": self._stream_anthropic,
            "openai": self._stream_openai,
            "google": self._stream_google,
        }
        stream = streamers[self.provider](list(self.history))
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
                partial = "".join(parts)
                self.history.append({"role": "assistant", "content": partial})
                self._trim_history()
                self._save_history()
                self._schedule_memory_update(user_text, partial)
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
        self._schedule_memory_update(user_text, reply)
        logger.info("LLM reply complete: %d chars in %.2fs", len(reply), time.perf_counter() - t0)

    async def stream_comment(self, cue: str) -> AsyncIterator[str]:
        """Proactive in-character comment from a live system cue (e.g. a game
        the user just opened). The cue is shown to the model as context but is
        NOT stored in history and skips repeat-detection — it's ephemeral
        banter, not part of the conversation transcript."""
        directive = (
            "SYSTEM EVENT — the user did NOT type this; it is a live cue about "
            f"what they are doing on their computer right now: {cue} "
            "React with ONE short, in-character spoken line about it, like you're "
            "hanging out watching them play. Use your usual personality (tease, "
            "cheer them on, act aloof) and the tag protocol as always."
        )
        self._turn_note = ""  # no repeat-detection for proactive comments
        messages = [*self.history, {"role": "user", "content": directive}]
        streamers = {
            "anthropic": self._stream_anthropic,
            "openai": self._stream_openai,
            "google": self._stream_google,
        }
        async for chunk in streamers[self.provider](messages):
            yield chunk

    # -- providers ----------------------------------------------------------

    async def _stream_anthropic(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        # Persona is the stable, cacheable prefix; the memory block is a
        # separate, uncached block since it changes as facts are learned.
        system: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": self.system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ]
        mem = self._memory_block()
        if mem:
            system.append({"type": "text", "text": mem})
        if self._turn_note:
            system.append({"type": "text", "text": self._turn_note})
        async with self._client.messages.stream(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def _stream_openai(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        stream = await self._client.chat.completions.create(
            model=self.model,
            max_tokens=self.max_tokens,
            stream=True,
            messages=[{"role": "system", "content": self._system_text()}, *messages],
        )
        async for event in stream:
            if event.choices and event.choices[0].delta and event.choices[0].delta.content:
                yield event.choices[0].delta.content

    async def _stream_google(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        from google.genai import types

        # Gemini uses role "model" for the assistant and nests text under
        # "parts"; the system prompt is passed separately via config.
        contents = [
            {
                "role": "model" if m["role"] == "assistant" else "user",
                "parts": [{"text": m["content"]}],
            }
            for m in messages
        ]
        stream = await self._client.aio.models.generate_content_stream(
            model=self.model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=self._system_text(),
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

    # -- long-term memory ---------------------------------------------------

    _TAG_RE = re.compile(r"\[[a-z_]+\]")

    def _strip_tags(self, text: str) -> str:
        """Drop the [emotion]/[gesture] markers so memory sees clean prose."""
        return re.sub(r"\s+", " ", self._TAG_RE.sub("", text)).strip()

    def _memory_block(self) -> str:
        """Render the known facts as a prompt block (empty string if none)."""
        if not self.memory:
            return ""
        facts = "\n".join(f"- {f}" for f in self.memory)
        return (
            "WHAT YOU REMEMBER ABOUT THE USER (from past conversations — weave "
            "it in naturally when relevant; never recite it like a list):\n" + facts
        )

    def _system_text(self) -> str:
        """Persona + memory + this turn's note, for single-string providers."""
        extra = "\n\n".join(b for b in (self._memory_block(), self._turn_note) if b)
        return f"{self.system_prompt}\n\n{extra}" if extra else self.system_prompt

    # -- repeated-question detection ----------------------------------------

    @staticmethod
    def _normalize(text: str) -> str:
        """Lowercase, strip punctuation, collapse whitespace — for comparison."""
        t = re.sub(r"[^a-z0-9\s]+", " ", text.lower())
        return re.sub(r"\s+", " ", t).strip()

    @classmethod
    def _similar(cls, a_norm: str, b_text: str) -> bool:
        b = cls._normalize(b_text)
        if not a_norm or not b:
            return False
        if a_norm == b:
            return True
        return difflib.SequenceMatcher(None, a_norm, b).ratio() >= 0.85

    def _repeat_note(self, user_text: str) -> str:
        """A directive when the user keeps asking the same thing, so she can
        tease them for it. Counts near-identical PRIOR user turns in history."""
        norm = self._normalize(user_text)
        if len(norm) < 4:
            return ""  # ignore trivial "hi"/"ok"-type messages
        repeats = sum(
            1 for m in self.history if m.get("role") == "user" and self._similar(norm, m.get("content", ""))
        )
        if repeats == 0:
            return ""
        times = repeats + 1
        logger.info("repeated question detected (%d times): %r", times, user_text[:60])
        return (
            f"CONTEXT (not spoken by the user): they have now asked essentially the "
            f"same thing {times} times in this conversation. Stay fully in character, "
            f"but call it out — tease or mock them playfully for repeating themselves "
            f"(sharper the more they repeat), then still give your answer. Keep it "
            f"good-natured, never genuinely harsh."
        )

    def _schedule_memory_update(self, user_text: str, reply: str) -> None:
        """Fire-and-forget the fact extraction so it never blocks the reply."""
        reply = self._strip_tags(reply)
        if not user_text.strip() or not reply:
            return
        task = asyncio.create_task(self._safe_update_memory(user_text, reply))
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    async def _safe_update_memory(self, user_text: str, reply: str) -> None:
        try:
            async with self._memory_lock:
                await self._update_memory(user_text, reply)
        except Exception as exc:  # memory is best-effort; never disturb the chat
            logger.warning("memory update failed: %s", exc)

    async def _update_memory(self, user_text: str, reply: str) -> None:
        """Ask the LLM to fold the latest exchange into the durable fact list."""
        logger.info("memory: distilling facts from latest exchange...")
        facts_block = "\n".join(f"- {f}" for f in self.memory) or "(none yet)"
        prompt = (
            "You maintain a concise long-term memory of durable facts about a "
            "user, for a friendly anime assistant named Kanee.\n\n"
            f"Current known facts about the user:\n{facts_block}\n\n"
            "Most recent exchange:\n"
            f"User said: {user_text}\n"
            f"Kanee replied: {reply}\n\n"
            "Return the UPDATED full list of durable facts about the USER as a "
            "JSON array of short strings. Rules:\n"
            "- Keep only lasting, useful facts about the user: their name, "
            "preferences, likes/dislikes, relationships, recurring activities, "
            "ongoing goals or situations, and important events.\n"
            "- Do NOT store Kanee's own statements, greetings, small talk, or "
            "one-off trivia.\n"
            "- Merge duplicates, update facts that changed, and drop facts that "
            "are no longer true.\n"
            "- Each fact is one short sentence. At most "
            f"{self.max_memory_facts} facts, keeping the most important.\n"
            "- If nothing new is worth remembering, return the current list "
            "unchanged.\n"
            "Output ONLY the JSON array, nothing else."
        )
        raw = await self._complete(prompt)
        facts = self._parse_facts(raw)
        if facts is None:
            return  # couldn't parse — keep the existing memory untouched
        facts = facts[: self.max_memory_facts]
        if facts != self.memory:
            self.memory = facts
            self._save_memory()
            logger.info("memory updated: %d fact(s) known", len(self.memory))

    @staticmethod
    def _parse_facts(raw: str) -> list[str] | None:
        """Parse a JSON array of strings, tolerating prose around it."""
        if not raw:
            return None
        text = raw.strip()
        if not text.startswith("["):
            start, end = text.find("["), text.rfind("]")
            if start == -1 or end <= start:
                return None
            text = text[start : end + 1]
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, list):
            return None
        return [str(x).strip() for x in data if str(x).strip()]

    async def _complete(self, prompt: str) -> str:
        """One non-streaming completion with retry (memory extraction only).

        Transient provider errors (e.g. Gemini 503 "high demand") are retried
        with backoff so a busy moment doesn't silently drop a memory update.
        """
        last: Exception | None = None
        for attempt in range(3):
            try:
                return await self._complete_once(prompt)
            except Exception as exc:  # noqa: BLE001 — retry any transient failure
                last = exc
                logger.info("memory extraction attempt %d failed: %s", attempt + 1, exc)
                await asyncio.sleep(1.5 * (attempt + 1))
        raise last if last else RuntimeError("completion failed")

    async def _complete_once(self, prompt: str) -> str:
        if self.provider == "anthropic":
            msg = await self._client.messages.create(
                model=self.model,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        if self.provider == "openai":
            resp = await self._client.chat.completions.create(
                model=self.model,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )
            return resp.choices[0].message.content or ""
        # google
        from google.genai import types

        resp = await self._client.aio.models.generate_content(
            model=self.model,
            contents=[{"role": "user", "parts": [{"text": prompt}]}],
            config=types.GenerateContentConfig(
                max_output_tokens=1024,
                response_mime_type="application/json",
            ),
        )
        return resp.text or ""

    def _load_memory(self) -> list[str]:
        if not self.memory_file.exists():
            return []
        try:
            data = json.loads(self.memory_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                facts = [str(x).strip() for x in data if str(x).strip()]
                logger.info("loaded %d remembered fact(s) from %s", len(facts), self.memory_file.name)
                return facts
            logger.warning("%s is not a list — starting with empty memory", self.memory_file.name)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "could not read %s (%s) — starting with empty memory", self.memory_file.name, exc
            )
        return []

    def _save_memory(self) -> None:
        try:
            self.memory_file.write_text(
                json.dumps(self.memory, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("could not save memory: %s", exc)
