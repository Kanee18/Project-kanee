"""Diagnose game detection. Run this from backend/ WHILE your game is open:

    py diagnose_games.py

It prints what the watcher sees, the real foreground window/process, any
game-ish processes it can find, then live-monitors for 60s so you can open and
close the game and watch whether it's detected. ASCII-only output (Windows
console friendly).
"""

import sys
import time

import game_watcher as gw

GAME_KEYWORDS = (
    "zen", "zone", "hoyo", "yuanshen", "genshin", "star", "rail", "valor",
    "league", "riot", "dota", "cs2", "csgo", "elden", "wuther", "game", "launcher",
)


def main() -> None:
    print("platform:", sys.platform)
    try:
        import psutil

        print("psutil:", psutil.__version__)
    except Exception as exc:  # noqa: BLE001
        psutil = None
        print("psutil NOT available:", exc)

    running, active = gw.detect_games()
    print("\ndetect_games() result:")
    print("  running games :", running or "{} (none matched)")
    print("  foreground game:", active)

    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        u = ctypes.windll.user32
        hwnd = u.GetForegroundWindow()
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        ln = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(ln + 1)
        u.GetWindowTextW(hwnd, buf, ln + 1)
        print("\nforeground window RIGHT NOW:")
        print("  title       :", repr(buf.value))
        if psutil is not None:
            try:
                print("  process name:", psutil.Process(pid.value).name())
            except Exception as exc:  # noqa: BLE001
                print("  process name: <cannot read:", exc, ">")

    if psutil is not None:
        print("\nrunning processes that look game-ish (name contains a keyword):")
        found = False
        for p in psutil.process_iter(["name"]):
            name = p.info.get("name") or ""
            low = name.lower()
            if any(k in low for k in GAME_KEYWORDS):
                in_list = low in {e.lower() for e in gw.GAMES}
                print(f"  {name:40s} {'<-- in GAMES list' if in_list else ''}")
                found = True
        if not found:
            print("  (none — psutil may be blocked from seeing the game process)")

    print("\n--- live monitor (60s). Open/close your game now; Ctrl+C to stop ---")
    prev = None
    end = time.time() + 60
    try:
        while time.time() < end:
            running, active = gw.detect_games()
            snapshot = (frozenset(running), active)
            if snapshot != prev:
                stamp = time.strftime("%H:%M:%S")
                print(f"{stamp}  running={set(running) or '{}'}  foreground={active}")
                prev = snapshot
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    print("done.")


if __name__ == "__main__":
    main()
