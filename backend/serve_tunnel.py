"""Run the Cloudflare quick tunnel AND publish its public URL to Firestore.

The deployed chat app reads `config/runtime.backendUrl` on load, so it always
finds the current backend — no manual URL sharing, no redeploy when the
quick-tunnel URL changes. On exit the URL is cleared (app shows offline).

Prereqs:
  - backend running on localhost:8000  (py -m uvicorn main:app --port 8000)
  - cloudflared.exe at the repo root    (downloaded once)
  - backend/serviceAccount.json         (Firebase service account)

Run from the backend/ directory:  py serve_tunnel.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

_BACKEND_DIR = Path(__file__).resolve().parent
_ROOT = _BACKEND_DIR.parent
_CLOUDFLARED = _ROOT / "cloudflared.exe"
_SA_PATH = _BACKEND_DIR / "serviceAccount.json"
_PORT = 8000
_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def main() -> None:
    if not _SA_PATH.exists():
        sys.exit("Missing backend/serviceAccount.json — download a Firebase service account key first.")
    if not _CLOUDFLARED.exists():
        sys.exit(f"Missing {_CLOUDFLARED} — download cloudflared.exe to the repo root.")

    firebase_admin.initialize_app(credentials.Certificate(str(_SA_PATH)))
    runtime = firestore.client().collection("config").document("runtime")

    print(f"[serve_tunnel] starting cloudflared -> http://localhost:{_PORT}")
    proc = subprocess.Popen(
        [str(_CLOUDFLARED), "tunnel", "--url", f"http://localhost:{_PORT}", "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    published: str | None = None
    try:
        for line in proc.stdout:  # type: ignore[union-attr]
            print(line, end="")
            match = _URL_RE.search(line)
            if match and match.group(0) != published:
                published = match.group(0)
                runtime.set({"backendUrl": published, "updatedAt": firestore.SERVER_TIMESTAMP})
                print(f"\n[serve_tunnel] >>> published backend URL to Firestore: {published}\n")
    except KeyboardInterrupt:
        print("\n[serve_tunnel] stopping…")
    finally:
        try:
            runtime.set({"backendUrl": "", "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
            print("[serve_tunnel] cleared backend URL (app will show offline).")
        except Exception as exc:  # noqa: BLE001
            print(f"[serve_tunnel] could not clear URL: {exc}")
        proc.terminate()


if __name__ == "__main__":
    main()
