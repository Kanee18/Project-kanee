# Kanee — landing site, accounts & beta gate (setup)

This adds a marketing website with sign-up/login (Firebase) in front of the
companion chat app. Visitors make an account; you grant **beta access** by hand;
approved users get a "Start chat with Kanee" button that opens the chat app.

```text
landing/   ← marketing site + sign in / sign up   (Vite, port 5180)
frontend/  ← the 3D companion chat app, now gated  (Vite, port 5173)
shared/    ← firebase-config.js used by BOTH apps
```

## 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**.
2. In the project, open **Build → Authentication → Get started**, then
   **Sign-in method** and enable:
   - **Email/Password**
   - **Google** (pick a support email when asked)
3. Open **Build → Firestore Database → Create database** → *Production mode* →
   choose a region. (Rules are set in step 3 below.)
4. Open **Project settings (gear) → General → Your apps → Web (`</>`)**,
   register an app (no Hosting needed), and copy the `firebaseConfig` values.

## 2. Fill in the shared config

Copy the example and paste your values:

```bash
cp shared/firebase-config.example.js shared/firebase-config.js
```

Edit `shared/firebase-config.js`:

```js
export const firebaseConfig = { apiKey: "…", authDomain: "…", projectId: "…", … };
export const CHAT_URL    = "http://localhost:5173"; // the companion app
export const SITE_URL    = "http://localhost:5180"; // this landing site
export const BETA_CONTACT = "you@example.com";       // where access requests go
```

`firebase-config.js` is gitignored (per-machine/project). Both apps read it.

> While `apiKey` is still `"YOUR_API_KEY"`, the landing shows a reminder toast
> and the companion gate offers a **"Continue without sign-in (dev)"** button so
> your 3D dev workflow isn't blocked. Once real values are in, the gate is live.

## 3. Firestore security rules

**Build → Firestore → Rules**, paste this, then **Publish**:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      // a signed-in user can read only their own doc
      allow read: if request.auth != null && request.auth.uid == uid;

      // they may create their own doc, but only with betaAccess = false
      allow create: if request.auth != null && request.auth.uid == uid
                    && request.resource.data.betaAccess == false;

      // they may update their own doc but may NEVER change betaAccess
      allow update: if request.auth != null && request.auth.uid == uid
                    && request.resource.data.betaAccess == resource.data.betaAccess;

      // only you (via the console) grant access; clients can't flip the flag
      allow delete: if false;
    }

    // backend URL published by the tunnel script (serve_tunnel.py). Any
    // signed-in user can read it; only the service account (which bypasses
    // rules) writes it.
    match /config/{doc} {
      allow read: if request.auth != null;
      allow write: if false;
    }
  }
}
```

This makes the gate tamper-proof: a user can't grant themselves access from the
browser.

## 4. Authorized domains

**Authentication → Settings → Authorized domains** already includes
`localhost`. When you deploy, add your real domains (e.g. `kanee.app`,
`app.kanee.app`).

## 5. Run it

Three terminals (TTS/backend as before, plus the two Vite apps):

```bash
# backend (unchanged)
cd backend && py -m uvicorn main:app --port 8000

# companion chat app
cd frontend && npm run dev      # → http://localhost:5173

# landing site
cd landing && npm run dev       # → http://localhost:5180
```

Open the landing site at <http://localhost:5180>.

## 6. Grant someone beta access

1. They sign up on the landing site (or in the chat gate). This creates
   `users/{uid}` with `betaAccess: false`.
2. In the Firebase console: **Firestore → Data → `users` → their doc → edit
   `betaAccess` → `true`**.
3. They click **"I've been approved — re-check"** in the chat gate (or reload
   the landing site). The chat unlocks.

To find the right user, the doc shows their `email`.

## How the pieces fit

- **Landing (`landing/`)** — Home / Features / Pricing / FAQ / Beta pages, plus
  the auth dialog. The hero CTA changes with state: *Request access* → *Awaiting
  approval* → *Start chat with Kanee*.
- **Companion (`frontend/`)** — `boot.js` runs `gate.js` first. The 3D app
  (`main.js`) is only imported once the user is signed in **and**
  `betaAccess === true`.
- **Cross-origin note** — the two apps run on different ports, so Firebase auth
  doesn't carry over automatically; the user signs in once on each. In
  production, serving both under the same domain removes the second sign-in.
  (The same Firebase account works in both either way.)

## Deploying with Firebase Hosting

The repo ships a `firebase.json` (two hosting sites: **landing** + **app**) and
a `.firebaserc` template. One-time setup:

```bash
npm install -g firebase-tools
firebase login

# create the two hosting sites (names must be globally unique)
firebase hosting:sites:create kanee-landing
firebase hosting:sites:create kanee-app

# map the deploy targets to those sites
firebase target:apply hosting landing kanee-landing
firebase target:apply hosting app kanee-app
```

Then edit `.firebaserc`: set `YOUR_PROJECT_ID` and the two site IDs.

Each deploy:

```bash
# build both apps
cd landing && npm run build && cd ..
cd frontend && npm run build && cd ..

# deploy
firebase deploy --only hosting:landing
firebase deploy --only hosting:app
```

After deploying, update `shared/firebase-config.js`:

```js
export const CHAT_URL = "https://kanee-app.web.app";      // your app site
export const SITE_URL = "https://kanee-landing.web.app";  // your landing site
```

…rebuild, redeploy, and add both domains under **Authentication → Settings →
Authorized domains** so Google sign-in works there.

> **Heads-up — the companion needs a live backend.** The landing site is fully
> static and deploys as-is. The chat app is static too, but it talks to the
> Python backend over a WebSocket (`/ws`) and to GPT-SoVITS. Hosting only serves
> the frontend; for a public chat you must also host the backend somewhere and
> point the app's WebSocket at it (today `ws.js` uses the same origin's `/ws`).
> During the beta it's fine to run the backend locally and only make the
> **landing** site public for sign-ups.

(Vercel / Netlify / Cloudflare Pages work too — point each at the matching app
folder, build `npm run build`, publish `dist/`.)

## Auto-deploy the landing site (GitHub Actions)

`.github/workflows/deploy-landing.yml` builds and deploys the **landing** site
to Firebase Hosting on every push to `main` that touches `landing/`, `shared/`,
or the Firebase config. Because `shared/firebase-config.js` is gitignored, the
workflow recreates it from repo variables at build time.

One-time setup (GitHub repo → **Settings**):

- **Secrets → Actions:**
  - `FIREBASE_SERVICE_ACCOUNT` — the JSON key of a service account with the
    **Firebase Hosting Admin** role (Google Cloud console → IAM → Service
    accounts → create key → paste the whole JSON).
- **Variables → Actions** (these aren't secret — the web config ships to the
  browser anyway):
  - `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`,
    `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`
  - `CHAT_URL`, `SITE_URL`, `BETA_CONTACT`

Also commit a real `.firebaserc` (project id + the `landing` site mapping) so
the deploy target resolves. After that, every push to `main` ships the landing
site automatically; you can also run it manually from the **Actions** tab.
