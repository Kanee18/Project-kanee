"""Milestones 1+2 — text loop CLI with streaming TTS.

stdin chat -> streaming LLM (tag protocol) -> incremental parser -> each
segment is sent to GPT-SoVITS THE MOMENT its sentence completes (while the
LLM is still streaming later sentences) -> audio plays sequentially.

The whole reply is never batched; time-to-first-audio is measured and logged.
If GPT-SoVITS is down or unconfigured, replies degrade to text-only and the
loop stays alive.

Run from the backend/ directory:

    python cli.py
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path
from typing import Optional

import yaml

from llm import LLMClient
from parser import Segment, StreamingTagParser
from tts import SovitsClient, TTSRequestError, TTSUnavailableError

logger = logging.getLogger("cli")


# -- audio playback (dev harness only — the real player is the browser) -------


def play_wav(data: bytes) -> None:
    """Blocking WAV playback. Called via asyncio.to_thread."""
    if sys.platform == "win32":
        import winsound

        winsound.PlaySound(data, winsound.SND_MEMORY)
        return
    # Non-Windows fallback for completeness.
    import os
    import shutil
    import subprocess
    import tempfile

    player = shutil.which("afplay") or shutil.which("aplay") or shutil.which("ffplay")
    if player is None:
        logger.warning("no audio player found (afplay/aplay/ffplay) — skipping playback")
        return
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        cmd = [player, path]
        if player.endswith("ffplay"):
            cmd = [player, "-nodisp", "-autoexit", "-loglevel", "quiet", path]
        subprocess.run(cmd, check=False, capture_output=True)
    finally:
        os.unlink(path)


def _print_segment(seg: Segment, elapsed: float, spoken: bool) -> None:
    tags = f"[{seg.emotion}]" + (f"[{seg.gesture}]" if seg.gesture else "")
    note = "" if spoken else "  (text-only)"
    print(f"  {tags} {seg.text}    (+{elapsed:.2f}s){note}")


# -- one request/reply cycle ---------------------------------------------------


async def chat_once(client: LLMClient, tts: Optional[SovitsClient], user_text: str) -> None:
    """Stream LLM -> parse -> synthesize per segment -> play in order.

    Three concurrent stages connected by queues, so synthesis of sentence N+1
    overlaps both the LLM still streaming and sentence N playing.
    """
    parser = StreamingTagParser()
    seg_q: asyncio.Queue[Optional[Segment]] = asyncio.Queue()
    audio_q: asyncio.Queue[Optional[tuple[Segment, Optional[bytes]]]] = asyncio.Queue()
    t0 = time.perf_counter()
    llm_error: Optional[Exception] = None
    n_parsed = 0
    first_audio_at: Optional[float] = None

    async def produce() -> None:
        """LLM stream -> parser -> segment queue."""
        nonlocal llm_error, n_parsed

        async def on_segment(seg: Segment) -> None:
            nonlocal n_parsed
            n_parsed += 1
            logger.info(
                "segment %d parsed at +%.2fs (tts queue depth %d): %r",
                n_parsed, time.perf_counter() - t0, seg_q.qsize(), seg.text[:48],
            )
            await seg_q.put(seg)

        try:
            async for chunk in client.stream_reply(user_text):
                for seg in parser.feed(chunk):
                    await on_segment(seg)
            for seg in parser.finish():
                await on_segment(seg)
        except Exception as exc:  # surfaced after the pipeline drains
            llm_error = exc
        finally:
            await seg_q.put(None)

    async def synthesize() -> None:
        """Segment queue -> GPT-SoVITS -> audio queue. One request at a time."""
        tts_down = tts is None
        while True:
            seg = await seg_q.get()
            if seg is None:
                break
            wav: Optional[bytes] = None
            if not tts_down:
                try:
                    wav = await tts.synthesize(seg.text)
                except TTSUnavailableError as exc:
                    tts_down = True  # don't hammer a dead server this reply
                    logger.error("%s", exc)
                    print(f"\n  !! {exc}\n  Continuing text-only for this reply.\n")
                except TTSRequestError as exc:
                    logger.warning("TTS rejected segment, continuing: %s", exc)
            await audio_q.put((seg, wav))
        await audio_q.put(None)

    async def play() -> None:
        """Audio queue -> sequential playback. Prints each segment as it starts."""
        nonlocal first_audio_at
        while True:
            item = await audio_q.get()
            if item is None:
                break
            seg, wav = item
            elapsed = time.perf_counter() - t0
            _print_segment(seg, elapsed, spoken=wav is not None)
            if wav is not None:
                if first_audio_at is None:
                    first_audio_at = elapsed
                    logger.info("time-to-first-audio: %.2fs", elapsed)
                await asyncio.to_thread(play_wav, wav)

    await asyncio.gather(produce(), synthesize(), play())
    if llm_error is not None:
        raise llm_error

    total = time.perf_counter() - t0
    logger.info(
        "reply done: %d segment(s), first audio at %s, total %.2fs",
        n_parsed,
        f"{first_audio_at:.2f}s" if first_audio_at is not None else "n/a (text-only)",
        total,
    )


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    config_path = Path(__file__).resolve().parent / "config.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    try:
        client = LLMClient(config)
    except Exception as exc:
        print(f"Could not start the LLM client: {exc}", file=sys.stderr)
        print(
            "Check backend/.env (API key — see .env.example) and the llm section of config.yaml.",
            file=sys.stderr,
        )
        return

    tts = SovitsClient.from_config(config)
    name = config["character"]["name"]
    mode = "voice + text" if tts is not None else "text-only (sovits not configured)"
    print(f"{name} is listening ({mode}). Type a message ('quit' to exit).")

    try:
        while True:
            try:
                user_text = (await asyncio.to_thread(input, "\nYou: ")).strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not user_text:
                continue
            if user_text.lower() in {"quit", "exit"}:
                break
            try:
                await chat_once(client, tts, user_text)
            except Exception as exc:
                logger.error("Reply failed: %s", exc)
                print(
                    "  (the LLM request failed — your message was not saved. "
                    "If this is an auth error, copy backend/.env.example to backend/.env "
                    "and set the API key for your provider.)"
                )
    finally:
        if tts is not None:
            await tts.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
