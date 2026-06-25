"""Streaming LLM client: provider selection, system prompt, conversation memory.

Yields raw reply chunks (which still contain the emotion/gesture tags);
turning the stream into tagged sentence segments is parser.py's job.

Conversation history and long-term memory are kept PER USER (keyed by the
authenticated uid), so beta users sharing one backend never see each other's
chat or "remembered facts". The local/dev user (uid == LOCAL_UID) keeps using
the original top-level history/memory files; every other uid is isolated under
backend/userdata/<uid>/.
"""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(_BACKEND_DIR / ".env")

# Sentinel uid for the single local/dev user (auth off). Imported by main.py so
# both sides agree on the key. The local user keeps the legacy file locations.
LOCAL_UID = "__local__"


def _safe_dir(uid: str) -> str:
    """A filesystem-safe directory name for a uid (defends against path
    traversal from an unexpected uid value)."""
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", uid):
        return uid
    return "u_" + hashlib.sha256(uid.encode("utf-8")).hexdigest()[:32]


@dataclass
class _UserState:
    """One user's isolated conversation state."""

    uid: str
    history_file: Path
    memory_file: Path
    history: list[dict[str, str]] = field(default_factory=list)
    memory: list[str] = field(default_factory=list)
    turn_note: str = ""  # transient per-turn directive injected into the system prompt
    memory_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class LLMClient:
    """Streams tagged character replies from the configured LLM provider.

    Shared across all connections; per-user state lives in `_UserState` objects
    looked up by uid via `_state()`.
    """

    def __init__(self, config: dict[str, Any]) -> None:
        llm_cfg = config["llm"]
        self.provider: str = llm_cfg.get("provider", "anthropic")
        self.model: str = llm_cfg["model"]
        self.max_tokens: int = int(llm_cfg.get("max_tokens", 1024))
        self.max_history_turns: int = int(llm_cfg.get("max_history_turns", 30))
        self.system_prompt: str = config["character"]["system_prompt"]

        # Per-user file names (the local user uses these at the backend root;
        # other users get their own copy under userdata/<uid>/).
        self._history_name: str = llm_cfg.get("history_file", "chat_history.json")
        self._memory_name: str = llm_cfg.get("memory_file", "user_memory.json")
        self.max_memory_facts: int = int(llm_cfg.get("max_memory_facts", 50))

        self._users: dict[str, _UserState] = {}
        self._bg_tasks: set[asyncio.Task[Any]] = set()

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

    # -- per-user state -----------------------------------------------------

    def _state(self, uid: str) -> _UserState:
        """Get (or lazily load) the isolated state for one user."""
        st = self._users.get(uid)
        if st is not None:
            return st
        if uid == LOCAL_UID:
            history_file = _BACKEND_DIR / self._history_name
            memory_file = _BACKEND_DIR / self._memory_name
        else:
            udir = _BACKEND_DIR / "userdata" / _safe_dir(uid)
            udir.mkdir(parents=True, exist_ok=True)
            history_file = udir / "chat_history.json"
            memory_file = udir / "user_memory.json"
        st = _UserState(uid=uid, history_file=history_file, memory_file=memory_file)
        st.history = self._load_history(st)
        st.memory = self._load_memory(st)
        # Materialize the memory file so it's visibly present from the start.
        if not st.memory_file.exists():
            self._save_memory(st)
        self._users[uid] = st
        return st

    async def stream_reply(self, user_text: str, user_id: str) -> AsyncIterator[str]:
        """Send one user message; yield the reply as raw text chunks.

        The user turn is added to history immediately and rolled back if the
        request fails, so a retry starts from a clean state. The assistant
        turn (with tags intact, to keep the persona consistent) is appended
        and persisted once the stream completes.
        """
        st = self._state(user_id)
        # Detect a repeated question (vs. prior turns) BEFORE appending this one,
        # so she can tease the user for asking the same thing again.
        st.turn_note = self._repeat_note(user_text, st)
        st.history.append({"role": "user", "content": user_text})
        t0 = time.perf_counter()
        first_chunk_at: float | None = None
        parts: list[str] = []
        streamers = {
            "anthropic": self._stream_anthropic,
            "openai": self._stream_openai,
            "google": self._stream_google,
        }
        stream = streamers[self.provider](list(st.history), st)
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
                st.history.append({"role": "assistant", "content": partial})
                self._trim_history(st)
                self._save_history(st)
                self._schedule_memory_update(user_text, partial, st)
            else:
                st.history.pop()
            raise
        except Exception:
            st.history.pop()
            raise
        reply = "".join(parts)
        st.history.append({"role": "assistant", "content": reply})
        self._trim_history(st)
        self._save_history(st)
        self._schedule_memory_update(user_text, reply, st)
        logger.info("LLM reply complete: %d chars in %.2fs", len(reply), time.perf_counter() - t0)

    async def stream_comment(self, cue: str, user_id: str) -> AsyncIterator[str]:
        """Proactive in-character comment from a live system cue (e.g. a game
        the user just opened). The cue is shown to the model as context but is
        NOT stored in history and skips repeat-detection — it's ephemeral
        banter, not part of the conversation transcript."""
        st = self._state(user_id)
        directive = (
            "SYSTEM EVENT — the user did NOT type this; it is a live cue about "
            f"what they are doing on their computer right now: {cue} "
            "React with ONE short, in-character spoken line about it, like you're "
            "hanging out watching them play. Use your usual personality (tease, "
            "cheer them on, act aloof) and the tag protocol as always."
        )
        st.turn_note = ""  # no repeat-detection for proactive comments
        messages = [*st.history, {"role": "user", "content": directive}]
        streamers = {
            "anthropic": self._stream_anthropic,
            "openai": self._stream_openai,
            "google": self._stream_google,
        }
        async for chunk in streamers[self.provider](messages, st):
            yield chunk

    # -- providers ----------------------------------------------------------

    async def _stream_anthropic(
        self, messages: list[dict[str, str]], st: _UserState
    ) -> AsyncIterator[str]:
        # Persona is the stable, cacheable prefix; the memory block is a
        # separate, uncached block since it changes as facts are learned.
        system: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": self.system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ]
        mem = self._memory_block(st)
        if mem:
            system.append({"type": "text", "text": mem})
        if st.turn_note:
            system.append({"type": "text", "text": st.turn_note})
        async with self._client.messages.stream(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def _stream_openai(
        self, messages: list[dict[str, str]], st: _UserState
    ) -> AsyncIterator[str]:
        stream = await self._client.chat.completions.create(
            model=self.model,
            max_tokens=self.max_tokens,
            stream=True,
            messages=[{"role": "system", "content": self._system_text(st)}, *messages],
        )
        async for event in stream:
            if event.choices and event.choices[0].delta and event.choices[0].delta.content:
                yield event.choices[0].delta.content

    async def _stream_google(
        self, messages: list[dict[str, str]], st: _UserState
    ) -> AsyncIterator[str]:
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
                system_instruction=self._system_text(st),
                max_output_tokens=self.max_tokens,
            ),
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text

    # -- history ------------------------------------------------------------

    def _trim_history(self, st: _UserState) -> None:
        limit = self.max_history_turns * 2  # one turn = user + assistant message
        if len(st.history) > limit:
            st.history = st.history[-limit:]

    def _load_history(self, st: _UserState) -> list[dict[str, str]]:
        if not st.history_file.exists():
            return []
        try:
            data = json.loads(st.history_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                logger.info("loaded %d history messages for %s", len(data), st.uid)
                return data
            logger.warning("%s is not a list — starting with empty history", st.history_file.name)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "could not read %s (%s) — starting with empty history", st.history_file.name, exc
            )
        return []

    def _save_history(self, st: _UserState) -> None:
        try:
            st.history_file.write_text(
                json.dumps(st.history, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("could not save chat history: %s", exc)

    # -- long-term memory ---------------------------------------------------

    _TAG_RE = re.compile(r"\[[a-z_]+\]")

    def _strip_tags(self, text: str) -> str:
        """Drop the [emotion]/[gesture] markers so memory sees clean prose."""
        return re.sub(r"\s+", " ", self._TAG_RE.sub("", text)).strip()

    def _memory_block(self, st: _UserState) -> str:
        """Render the known facts as a prompt block (empty string if none)."""
        if not st.memory:
            return ""
        facts = "\n".join(f"- {f}" for f in st.memory)
        return (
            "WHAT YOU REMEMBER ABOUT THE USER (from past conversations — weave "
            "it in naturally when relevant; never recite it like a list):\n" + facts
        )

    def _system_text(self, st: _UserState) -> str:
        """Persona + memory + this turn's note, for single-string providers."""
        extra = "\n\n".join(b for b in (self._memory_block(st), st.turn_note) if b)
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

    def _repeat_note(self, user_text: str, st: _UserState) -> str:
        """A directive when the user keeps asking the same thing, so she can
        tease them for it. Counts near-identical PRIOR user turns in history."""
        norm = self._normalize(user_text)
        if len(norm) < 4:
            return ""  # ignore trivial "hi"/"ok"-type messages
        repeats = sum(
            1 for m in st.history if m.get("role") == "user" and self._similar(norm, m.get("content", ""))
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

    def _schedule_memory_update(self, user_text: str, reply: str, st: _UserState) -> None:
        """Fire-and-forget the fact extraction so it never blocks the reply."""
        reply = self._strip_tags(reply)
        if not user_text.strip() or not reply:
            return
        task = asyncio.create_task(self._safe_update_memory(user_text, reply, st))
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    async def _safe_update_memory(self, user_text: str, reply: str, st: _UserState) -> None:
        try:
            async with st.memory_lock:
                await self._update_memory(user_text, reply, st)
        except Exception as exc:  # memory is best-effort; never disturb the chat
            logger.warning("memory update failed: %s", exc)

    async def _update_memory(self, user_text: str, reply: str, st: _UserState) -> None:
        """Ask the LLM to fold the latest exchange into the durable fact list."""
        logger.info("memory: distilling facts from latest exchange for %s...", st.uid)
        facts_block = "\n".join(f"- {f}" for f in st.memory) or "(none yet)"
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
        if facts != st.memory:
            st.memory = facts
            self._save_memory(st)
            logger.info("memory updated for %s: %d fact(s) known", st.uid, len(st.memory))

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

    def _load_memory(self, st: _UserState) -> list[str]:
        if not st.memory_file.exists():
            return []
        try:
            data = json.loads(st.memory_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                facts = [str(x).strip() for x in data if str(x).strip()]
                logger.info("loaded %d remembered fact(s) for %s", len(facts), st.uid)
                return facts
            logger.warning("%s is not a list — starting with empty memory", st.memory_file.name)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "could not read %s (%s) — starting with empty memory", st.memory_file.name, exc
            )
        return []

    def _save_memory(self, st: _UserState) -> None:
        try:
            st.memory_file.write_text(
                json.dumps(st.memory, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("could not save memory: %s", exc)
