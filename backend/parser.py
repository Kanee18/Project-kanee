"""Incremental sentence/tag parser for the streamed LLM reply.

Consumes arbitrary text chunks as they arrive from the LLM token stream and
emits a ``Segment`` the moment a sentence is complete — i.e. when text ending
in terminal punctuation is followed by the next tag, or at end of stream.

Protocol (see CLAUDE.md): every sentence is prefixed with one emotion tag,
optionally followed by one gesture tag, e.g.::

    [excited][bounce] Oh my gosh, you're back! [happy][wave] I missed you.

Rules implemented here:
- Tags are stripped from the text (never sent to TTS).
- Malformed/unknown tags fall back to neutral with a warning; never crash.
- Interjections without terminal punctuation ("Hmm," "Well...") attach to the
  following sentence. A trailing ellipsis is treated as non-terminal.
- Multi-sentence text under a single tag stays one segment.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import List, Optional

logger = logging.getLogger(__name__)

EMOTIONS = {
    "neutral", "happy", "excited", "sad", "angry",
    "surprised", "shy", "pout", "curious", "smug",
}
GESTURES = {
    "wave", "nod", "shake", "think", "clap",
    "bounce", "tilt", "lean_in", "fidget", "peace",
}

# A complete tag is "[" + letters/underscores + "]".
_TAG_INNER = re.compile(r"[A-Za-z_]+")
# "[" followed only by letters/underscores up to the end of the buffer could
# still become a tag once more chunks arrive — hold it back.
_PARTIAL_TAG = re.compile(r"\[[A-Za-z_]*")


@dataclass
class Segment:
    """One spoken sentence with its animation metadata."""

    emotion: str
    gesture: Optional[str]
    text: str


def _ends_terminal(text: str) -> bool:
    """True if ``text`` ends a sentence (., !, ? — but not a trailing-off ellipsis)."""
    t = text.rstrip().rstrip("\"'”’»)")
    if not t:
        return False
    if t.endswith("...") or t.endswith("…"):
        return False
    return t[-1] in ".!?"


class StreamingTagParser:
    """Feed it LLM text chunks; collect Segments as sentences complete.

    Usage::

        parser = StreamingTagParser()
        for chunk in llm_stream:
            for segment in parser.feed(chunk):
                ...
        for segment in parser.finish():
            ...
    """

    def __init__(self) -> None:
        self._buf = ""                      # raw input not yet scanned
        self._text = ""                     # text of the segment being built
        self._emotion: Optional[str] = None
        self._gesture: Optional[str] = None
        self._in_tag_group = False          # consecutive tags share one boundary check

    def feed(self, chunk: str) -> List[Segment]:
        """Consume one stream chunk; return any segments completed by it."""
        self._buf += chunk
        out: List[Segment] = []
        while True:
            lb = self._buf.find("[")
            if lb == -1:
                # No tag candidate — everything is sentence text.
                self._append_text(self._buf)
                self._buf = ""
                break
            self._append_text(self._buf[:lb])
            self._buf = self._buf[lb:]
            rb = self._buf.find("]")
            if rb == -1:
                if _PARTIAL_TAG.fullmatch(self._buf):
                    break  # might still become a tag — wait for more input
                # "[" followed by non-tag characters: it's literal text.
                self._append_text(self._buf[0])
                self._buf = self._buf[1:]
                continue
            inner = self._buf[1:rb]
            token = self._buf[: rb + 1]
            self._buf = self._buf[rb + 1:]
            if _TAG_INNER.fullmatch(inner):
                segment = self._on_tag(inner.lower())
                if segment is not None:
                    out.append(segment)
            else:
                # Bracketed content that isn't tag-shaped ("[over 9000]") is text.
                self._append_text(token)
        return out

    def finish(self) -> List[Segment]:
        """End of stream: flush whatever remains as the final segment."""
        if self._buf:
            if _PARTIAL_TAG.fullmatch(self._buf):
                logger.warning("Stream ended mid-tag — dropping partial token %r", self._buf)
            else:
                self._append_text(self._buf)
            self._buf = ""
        segment = self._make_segment()
        return [segment] if segment is not None else []

    # -- internals ----------------------------------------------------------

    def _append_text(self, s: str) -> None:
        if not s:
            return
        self._text += s
        if s.strip():
            self._in_tag_group = False

    def _on_tag(self, name: str) -> Optional[Segment]:
        """Handle one complete, tag-shaped token. May complete a segment."""
        is_emotion = name in EMOTIONS
        is_gesture = name in GESTURES
        if not (is_emotion or is_gesture):
            logger.warning("Unknown tag [%s] — stripped (emotion falls back to neutral)", name)
            return None
        emitted: Optional[Segment] = None
        # Only the first tag of a [emotion][gesture] group decides whether the
        # accumulated text is emitted or carried into the next segment.
        if not self._in_tag_group and self._text.strip():
            if _ends_terminal(self._text):
                emitted = self._make_segment()
            else:
                # Interjection / unterminated text attaches to the next
                # sentence; the new sentence's tags apply to the merged text.
                logger.debug("Unterminated text %r carried into next segment", self._text.strip())
                self._emotion = None
                self._gesture = None
        self._in_tag_group = True
        if is_emotion:
            if self._emotion is not None:
                logger.debug("Emotion [%s] overrides earlier [%s]", name, self._emotion)
            self._emotion = name
        else:
            self._gesture = name
        return emitted

    def _make_segment(self) -> Optional[Segment]:
        text = " ".join(self._text.split())  # normalize whitespace/newlines
        self._text = ""
        emotion = self._emotion
        gesture = self._gesture
        self._emotion = None
        self._gesture = None
        if not text:
            return None
        if emotion is None:
            logger.warning("Sentence had no emotion tag — defaulting to [neutral]: %r", text[:60])
            emotion = "neutral"
        return Segment(emotion=emotion, gesture=gesture, text=text)
