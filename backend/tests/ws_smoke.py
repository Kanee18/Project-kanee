"""Manual WebSocket protocol smoke test (Milestone 3).

Not a pytest test — talks to the real pipeline (LLM + TTS if running):

    py tests/ws_smoke.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from starlette.testclient import TestClient

from main import app


def collect_reply(ws, limit: int = 40) -> list[dict]:
    messages = []
    for _ in range(limit):
        msg = json.loads(ws.receive_text())
        kind = msg["type"]
        if kind == "segment":
            audio = msg.get("audio")
            print(
                f"  segment  [{msg['emotion']}]"
                + (f"[{msg['gesture']}]" if msg.get("gesture") else "")
                + f" {msg['text']!r}  audio={'%d KiB' % (len(audio) * 3 // 4 // 1024) if audio else 'none'}"
            )
        else:
            print(f"  {kind:9s}", {k: v for k, v in msg.items() if k != 'type'})
        messages.append(msg)
        if kind == "reply_done":
            break
    return messages


def main() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            print("-- send user_text")
            ws.send_text(json.dumps({"type": "user_text", "text": "Say hi in exactly two short sentences."}))
            messages = collect_reply(ws)

            kinds = [m["type"] for m in messages]
            assert kinds[0] == "state" and messages[0]["value"] == "thinking", kinds
            assert "segment" in kinds, kinds
            assert kinds[-1] == "reply_done" or "reply_done" in kinds, kinds
            segs = [m for m in messages if m["type"] == "segment"]
            assert all(m["emotion"] for m in segs)
            assert any(m["type"] == "state" and m["value"] == "speaking" for m in messages), kinds

            # trailing idle state after reply_done
            tail = json.loads(ws.receive_text())
            assert tail == {"type": "state", "value": "idle"}, tail

            print("-- send interrupt mid-reply")
            ws.send_text(json.dumps({"type": "user_text", "text": "Count slowly from one to twenty."}))
            first = json.loads(ws.receive_text())
            assert first["value"] == "thinking", first
            ws.send_text(json.dumps({"type": "interrupt"}))
            got_idle = False
            for _ in range(40):
                msg = json.loads(ws.receive_text())
                print(f"  {msg['type']:9s}", (msg.get('value') or msg.get('text') or '')[:60])
                if msg["type"] == "state" and msg["value"] == "idle":
                    got_idle = True
                    break
            assert got_idle, "never returned to idle after interrupt"

            print("-- send unknown type")
            ws.send_text(json.dumps({"type": "bogus"}))
            msg = json.loads(ws.receive_text())
            assert msg["type"] == "error", msg
            print(f"  error     {msg['message']!r}")

    print("\nPROTOCOL SMOKE TEST PASSED")


if __name__ == "__main__":
    main()
