# Exposing the backend with Cloudflare Tunnel

Your backend (FastAPI + WebSocket) and GPT-SoVITS run on your local GPU machine.
A Cloudflare Tunnel gives them a public **HTTPS/WSS** URL so the deployed chat
app can reach them — free, no router port-forwarding, TLS included.

```
Browser (kanee-app.web.app, HTTPS)
        │  wss://<your-tunnel>/ws
        ▼
Cloudflare edge ──tunnel──► cloudflared (your PC) ──► localhost:8000 (FastAPI)
                                                   └─► localhost:9880 (GPT-SoVITS)
```

## 0. Prerequisites

Start your stack locally as usual, all on the same machine:

```powershell
# GPT-SoVITS (separate project), e.g.
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

# this backend
cd backend
py -m uvicorn main:app --port 8000
```

Install cloudflared (Windows):

```powershell
winget install --id Cloudflare.cloudflared
# or download cloudflared.exe from
# https://github.com/cloudflare/cloudflared/releases and put it on your PATH
```

---

## Recommended: automated setup (one click, auto URL, secured)

This is the "my PC is the server" flow. The chat app discovers the backend URL
automatically and only approved accounts can connect.

### One-time

1. **Service account** — Firebase console → Project settings → *Service
   accounts* → **Generate new private key**. Save it as
   `backend/serviceAccount.json` (gitignored). It powers two things:
   - the backend verifies each visitor's Firebase token + beta access, and
   - `serve_tunnel.py` publishes the live URL to Firestore.
2. **Install the dep:** `py -m pip install firebase-admin`
3. **Firestore rule** for the published URL — add the `config/{doc}` block from
   `landing/SETUP.md` and Publish.
4. **`cloudflared.exe`** at the repo root (already downloaded).

### Every time you want to be online

Just run the launcher from the repo root:

```powershell
./start-server.ps1
```

It opens the **backend** and the **tunnel** (`serve_tunnel.py`) in separate
windows. `serve_tunnel.py` starts cloudflared, grabs the public URL, and writes
it to Firestore `config/runtime.backendUrl`. The deployed chat app reads that on
load — so testers just open **kanee-app.web.app** and click **Start chat**, no
URL to copy. (Start GPT-SoVITS too, or set `$SovitsDir` in the script.)

When you stop the tunnel window (Ctrl+C), the URL is cleared and the app shows
offline. With the service account in place, the backend rejects anyone who
isn't a signed-in, beta-approved user — so a leaked URL can't run up your bill.

> The manual options below still work (e.g. `?api=` for quick debugging, or a
> fixed `BACKEND_URL`). They're just not needed with the automated flow.

---

## Option A — Quick Tunnel (fastest, no account/domain)

Good for getting testers in today. The URL is random and changes each run.

```powershell
cloudflared tunnel --url http://localhost:8000
```

It prints a line like:

```
https://random-words-1234.trycloudflare.com
```

Point the chat app at it (pick one):

- **Per-visit (no rebuild):** open the chat app with `?api=` appended, once:
  `https://kanee-app.web.app/?api=https://random-words-1234.trycloudflare.com`
  The app saves it (localStorage) and reuses it next time. Great while the
  quick-tunnel URL keeps changing.
- **Baked in:** set `BACKEND_URL` in `shared/firebase-config.js` to that URL,
  then rebuild + redeploy the chat app (see below). You'd repeat this whenever
  the quick-tunnel URL changes — which is why Option B is nicer long-term.

Keep the `cloudflared` window open while testers are using it.

---

## Option B — Named Tunnel (stable hostname, needs a domain on Cloudflare)

Best for an ongoing beta: a fixed URL like `https://api.kanee.app` you set once.
Requires a domain added to your Cloudflare account.

```powershell
cloudflared tunnel login                      # authorize in the browser
cloudflared tunnel create kanee-api           # creates a tunnel + credentials
cloudflared tunnel route dns kanee-api api.kanee.app
```

Create `config.yml` (path shown by `cloudflared`; usually
`C:\Users\<you>\.cloudflared\config.yml`):

```yaml
tunnel: kanee-api
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: api.kanee.app
    service: http://localhost:8000
  - service: http_status:404
```

Run it (optionally install as a service so it survives reboots):

```powershell
cloudflared tunnel run kanee-api
# or, to run on startup:
cloudflared service install
```

Then set it once and forget:

```js
// shared/firebase-config.js
export const BACKEND_URL = "https://api.kanee.app";
```

---

## Point the deployed chat app at the backend

For remote testers, the chat app (`kanee-app`) must be deployed and know the
backend URL. After setting `BACKEND_URL` (Option B) — or to bake in a quick URL:

```powershell
# build + deploy the chat app
cd frontend; npm run build; cd ..
firebase deploy --only hosting:app
```

Also, so sign-in works on the chat origin:

- Firebase Console → **Authentication → Settings → Authorized domains** → add
  `kanee-app.web.app`.
- In `shared/firebase-config.js`, set `CHAT_URL = "https://kanee-app.web.app"`,
  then rebuild + redeploy the **landing** so its "Start chat" button points there.

> Local development is unaffected: with `BACKEND_URL = ""` and no `?api=`, the
> app uses same-origin `/ws`, which Vite proxies to `localhost:8000`.

---

## ⚠️ Security — the backend is open

Anyone who has the tunnel URL can open the WebSocket and use your LLM + GPU,
which costs you money. The Firebase gate is on the **frontend** only; it does
not protect the backend by itself.

For a small private beta, keeping the URL unshared is usually enough. To harden
it, options (ask and I can wire one up):

- **Cloudflare Access** in front of the tunnel (email/SSO allowlist) — no code.
- **Firebase ID-token check**: the app sends the signed-in user's token on
  connect; the backend verifies it with the Firebase Admin SDK and only then
  serves the reply. Strongest, ties backend access to approved accounts.
- A simple shared secret in the connect URL (weak, but stops random scanners).

## Notes

- Keep both `cloudflared` and the backend (and GPT-SoVITS) running while testers
  are online — they're connecting straight to your machine.
- `chat_history.json` / `user_memory.json` live on your disk; they persist as
  long as you run on the same machine. Moving to multi-user hosting later means
  moving that state into a database.
