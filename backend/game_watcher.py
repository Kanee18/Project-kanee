"""Local game-presence watcher (Windows).

Polls the FOREGROUND window and maps it to a known game, so the assistant can
proactively comment when the user starts playing — and occasionally while they
keep playing. Everything is local: it only reads the active window's process
name/title; nothing is sent anywhere except the LLM call that phrases the line.

In-game events (battle / win / loss) are intentionally NOT handled here — those
aren't exposed by games and would need screen-capture + a vision model.
"""

from __future__ import annotations

import asyncio
import logging
import random
import sys
import time
from typing import Callable, Optional

logger = logging.getLogger("game")

# Foreground process exe (lowercase) → display name. Add your own games here.
GAMES: dict[str, str] = {
    "genshinimpact.exe": "Genshin Impact",
    "yuanshen.exe": "Genshin Impact",
    "starrail.exe": "Honkai: Star Rail",
    "ZenlessZoneZero.exe": "Zenless Zone Zero",
    "wuthering waves.exe": "Wuthering Waves",
    "client-win64-shipping.exe": "Wuthering Waves",
    "valorant.exe": "Valorant",
    "valorant-win64-shipping.exe": "Valorant",
    "league of legends.exe": "League of Legends",
    "leagueclient.exe": "League of Legends",
    "dota2.exe": "Dota 2",
    "csgo.exe": "Counter-Strike",
    "cs2.exe": "Counter-Strike 2",
    "eldenring.exe": "Elden Ring",
    "stardewvalley.exe": "Stardew Valley",
    "factorio.exe": "Factorio",
    "hades.exe": "Hades",
    "hades2.exe": "Hades II",
    "terraria.exe": "Terraria",
    "rainbowsix.exe": "Rainbow Six Siege",
}

# Fallback: substring match on the window title when the exe is generic.
TITLE_KEYWORDS: dict[str, str] = {
    "minecraft": "Minecraft",
    "genshin impact": "Genshin Impact",
    "honkai: star rail": "Honkai: Star Rail",
    "roblox": "Roblox",
}

POLL_SECONDS = 4.0          # how often we check running processes / foreground
AMBIENT_MIN = 200.0         # random "still playing" comment window (s)
AMBIENT_MAX = 420.0


def detect_games() -> tuple[set[str], Optional[str]]:
    """(games currently RUNNING, the game in the FOREGROUND or None). Windows.

    Running is driven by process presence (so start/stop = launch/exit, not
    alt-tabbing). Foreground is used only to pace "still playing" comments.
    """
    if sys.platform != "win32":
        return set(), None

    try:
        import psutil
    except Exception:
        psutil = None

    games_lower = {exe.lower(): name for exe, name in GAMES.items()}
    running: set[str] = set()
    active: Optional[str] = None

    if psutil is not None:
        try:
            for proc in psutil.process_iter(["name"]):
                disp = games_lower.get((proc.info.get("name") or "").lower())
                if disp:
                    running.add(disp)
        except Exception as exc:
            logger.debug("process scan failed: %s", exc)

    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if hwnd:
            if psutil is not None:
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                try:
                    active = games_lower.get(psutil.Process(pid.value).name().lower())
                except Exception:
                    active = None
            if active is None:  # title fallback for generic exes
                length = user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = (buf.value or "").lower()
                for keyword, disp in TITLE_KEYWORDS.items():
                    if keyword in title:
                        active = disp
                        break
            if active:
                running.add(active)  # title-only games count as running too
    except Exception as exc:  # never let detection crash the server
        logger.debug("foreground detection failed: %s", exc)

    return running, active


class GameWatcher:
    """Polls running games + the foreground and fires on_event(kind, game,
    minutes) on the loop.

    kind: "start" (a game just launched), "stop" (a game just closed; minutes =
    how long it ran), "ambient" (still playing — fired only while the game is in
    the foreground). The callback should be cheap (it just schedules a comment).
    """

    def __init__(self, on_event: Callable[[str, str, Optional[float]], None]) -> None:
        self._on_event = on_event
        self._task: Optional[asyncio.Task] = None
        self._running: set[str] = set()           # games running as of last poll
        self._started_at: dict[str, float] = {}    # game -> monotonic launch time
        self._next_ambient = 0.0

    def start(self) -> None:
        if sys.platform != "win32":
            logger.info("game watcher disabled (not Windows)")
            return
        self._task = asyncio.create_task(self._run())
        logger.info("game watcher started (%d games known)", len(GAMES))

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except BaseException:
                pass
        self._task = None

    async def _run(self) -> None:
        loop = asyncio.get_event_loop()
        while True:
            try:
                running, active = await loop.run_in_executor(None, detect_games)
                now = time.monotonic()
                # First poll has an empty _running, so a game already open when
                # you connect is announced too (not silently ignored).
                for game in running - self._running:    # just launched / already up
                    self._started_at[game] = now
                    self._fire("start", game, None)
                    self._next_ambient = now + random.uniform(AMBIENT_MIN, AMBIENT_MAX)
                for game in self._running - running:     # just closed
                    minutes = (now - self._started_at.pop(game, now)) / 60.0
                    self._fire("stop", game, minutes)
                self._running = running
                # "still playing" only while the game is actually in front
                if active and now >= self._next_ambient:
                    self._fire("ambient", active, None)
                    self._next_ambient = now + random.uniform(AMBIENT_MIN, AMBIENT_MAX)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("game watcher loop error: %s", exc)
            await asyncio.sleep(POLL_SECONDS)

    def _fire(self, kind: str, game: str, minutes: Optional[float]) -> None:
        logger.info(
            "game event: %s %s%s", kind, game,
            f" ({minutes:.0f}m)" if minutes is not None else "",
        )
        try:
            self._on_event(kind, game, minutes)
        except Exception as exc:
            logger.warning("game on_event failed: %s", exc)
