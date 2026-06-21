/**
 * Access gate for the companion app.
 *
 * requireAccess() shows a full-screen overlay and resolves ONLY when the user
 * is signed in AND their Firestore profile has betaAccess === true. The caller
 * boots the 3D app after it resolves, so nothing heavy loads for users who
 * can't get in.
 *
 * States: loading → (login | pending | granted). Because the companion runs on
 * a different origin than the landing site, the user signs in here too (same
 * Firebase project, so the same account works).
 */
import {
  watchAuth,
  refreshProfile,
  loginGoogle,
  loginEmail,
  signUpEmail,
  logout,
  authErrorMessage,
} from "./auth.js";
import { SITE_URL, BETA_CONTACT, firebaseConfig } from "../../shared/firebase-config.js";

const STYLE = `
.kgate { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center;
  background: radial-gradient(900px 600px at 70% -10%, rgba(232,127,166,.18), transparent 60%), #07060b;
  color: #f3eff4; font-family: "Segoe UI", system-ui, sans-serif; padding: 20px; }
.kgate-card { width: 100%; max-width: 380px; background: rgba(20,19,28,.96);
  border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 1.8rem 1.6rem;
  box-shadow: 0 30px 80px rgba(0,0,0,.6); text-align: center; }
.kgate-brand { display:flex; align-items:center; justify-content:center; gap:.5rem; font-weight:700; font-size:1.15rem; margin-bottom: 1.1rem; }
.kgate-brand b { color:#e87fa6; }
.kgate h2 { margin: 0 0 .4rem; font-size: 1.25rem; }
.kgate p { color:#b7b1c2; font-size:.92rem; margin:.3rem 0 1rem; }
.kgate-tabs { display:flex; gap:.3rem; background:rgba(0,0,0,.25); border-radius:11px; padding:.25rem; margin-bottom: .9rem; }
.kgate-tab { flex:1; background:none; border:none; color:#b7b1c2; font:inherit; font-weight:600; padding:.5rem; border-radius:8px; cursor:pointer; }
.kgate-tab.active { background:rgba(19,18,27,.9); color:#f3eff4; }
.kgate input { width:100%; font:inherit; color:#f3eff4; background:rgba(0,0,0,.25);
  border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:.6rem .75rem; margin-bottom:.6rem; }
.kgate input:focus { outline:none; border-color:#e87fa6; }
.kbtn { width:100%; font:inherit; font-weight:600; cursor:pointer; border:1px solid transparent;
  border-radius:10px; padding:.62rem 1rem; display:flex; align-items:center; justify-content:center; gap:.5rem; margin-bottom:.55rem; }
.kbtn.solid { background:linear-gradient(100deg,#d4548a,#e87fa6); color:#2a0f1c; }
.kbtn.ghost { background:rgba(255,255,255,.05); color:#f3eff4; border-color:rgba(255,255,255,.12); }
.kbtn.google { background:#fff; color:#1f1f1f; }
.kbtn[disabled]{ opacity:.55; cursor:not-allowed; }
.kgate-or { display:flex; align-items:center; gap:.7rem; color:#8a8499; font-size:.8rem; margin:.5rem 0 .8rem; }
.kgate-or::before,.kgate-or::after{ content:""; flex:1; height:1px; background:rgba(255,255,255,.12); }
.kgate-msg { min-height:1.1em; font-size:.85rem; color:#8a8499; margin-top:.4rem; }
.kgate-msg.error { color:#f0889a; }
.kgate-link { color:#7fb2e8; font-size:.85rem; display:inline-block; margin-top:.7rem; cursor:pointer; }
.kgate-spin { width:34px; height:34px; border-radius:50%; margin:1rem auto; border:3px solid rgba(255,255,255,.15); border-top-color:#e87fa6; animation:kspin 1s linear infinite; }
@keyframes kspin { to { transform: rotate(360deg); } }
`;

const BRAND = `<div class="kgate-brand">💗 <span>Kanee</span></div>`;

export function requireAccess() {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "kgate";
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);
    const card = document.createElement("div");
    card.className = "kgate-card";
    root.appendChild(card);
    document.body.appendChild(root);

    let unsub = () => {};
    const grant = () => {
      unsub();
      root.remove();
      resolve();
    };

    // No Firebase yet? Let the dev in so the 3D workflow isn't blocked.
    if (firebaseConfig.apiKey === "YOUR_API_KEY") {
      card.innerHTML = `${BRAND}
        <h2>Firebase not configured</h2>
        <p>Sign-in is disabled until you fill in <code>shared/firebase-config.js</code> (see SETUP.md).</p>
        <button class="kbtn solid" id="kgate-dev">Continue without sign-in (dev)</button>`;
      card.querySelector("#kgate-dev").onclick = grant;
      return;
    }

    showLoading("Checking your access…");

    function showLoading(msg) {
      card.innerHTML = `${BRAND}<div class="kgate-spin"></div><p>${msg}</p>`;
    }

    function showLogin() {
      let mode = "login"; // "login" | "signup"
      card.innerHTML = `${BRAND}
        <h2>Welcome back</h2>
        <p>Sign in to chat with Kanee.</p>
        <div class="kgate-tabs">
          <button class="kgate-tab active" data-tab="login">Log in</button>
          <button class="kgate-tab" data-tab="signup">Sign up</button>
        </div>
        <button class="kbtn google" id="k-google">Continue with Google</button>
        <div class="kgate-or"><span>or</span></div>
        <input type="text" id="k-name" placeholder="Name" hidden />
        <input type="email" id="k-email" placeholder="you@example.com" autocomplete="email" />
        <input type="password" id="k-pass" placeholder="Password" autocomplete="current-password" />
        <button class="kbtn solid" id="k-submit">Log in</button>
        <div class="kgate-msg" id="k-msg"></div>
        <a class="kgate-link" href="${SITE_URL}">← Back to the site</a>`;

      const msg = card.querySelector("#k-msg");
      const setMode = (m) => {
        mode = m;
        card.querySelectorAll(".kgate-tab").forEach((t) =>
          t.classList.toggle("active", t.dataset.tab === m)
        );
        card.querySelector("#k-name").hidden = m !== "signup";
        card.querySelector("#k-submit").textContent = m === "signup" ? "Create account" : "Log in";
        msg.textContent = "";
        msg.classList.remove("error");
      };
      card.querySelectorAll(".kgate-tab").forEach((t) =>
        t.addEventListener("click", () => setMode(t.dataset.tab))
      );

      const fail = (err) => {
        msg.textContent = authErrorMessage(err);
        msg.classList.add("error");
      };

      card.querySelector("#k-google").onclick = async () => {
        msg.textContent = "Opening Google…";
        try {
          await loginGoogle();
        } catch (err) {
          fail(err);
        }
      };

      card.querySelector("#k-submit").onclick = async () => {
        const email = card.querySelector("#k-email").value.trim();
        const pass = card.querySelector("#k-pass").value;
        const name = card.querySelector("#k-name").value.trim();
        msg.classList.remove("error");
        msg.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
        try {
          if (mode === "signup") await signUpEmail(email, pass, name);
          else await loginEmail(email, pass);
        } catch (err) {
          fail(err);
        }
      };
      card.querySelector("#k-pass").addEventListener("keydown", (e) => {
        if (e.key === "Enter") card.querySelector("#k-submit").click();
      });
    }

    function showPending(user) {
      const contact = `mailto:${BETA_CONTACT}?subject=${encodeURIComponent("Kanee beta access request")}`;
      card.innerHTML = `${BRAND}
        <h2>Almost there ✨</h2>
        <p>Hi ${user.displayName || user.email}! Your account is created, but beta access
        hasn't been granted yet. Contact us and we'll unlock it by hand.</p>
        <a class="kbtn solid" href="${contact}">Request access</a>
        <button class="kbtn ghost" id="k-recheck">I've been approved — re-check</button>
        <button class="kbtn ghost" id="k-logout">Sign out</button>
        <div class="kgate-msg" id="k-msg"></div>
        <a class="kgate-link" href="${SITE_URL}">← Back to the site</a>`;

      const msg = card.querySelector("#k-msg");
      card.querySelector("#k-recheck").onclick = async () => {
        msg.classList.remove("error");
        msg.textContent = "Checking…";
        try {
          const profile = await refreshProfile();
          if (profile?.betaAccess === true) return grant();
          msg.textContent = "Not yet — still pending. Hang tight!";
        } catch (err) {
          msg.textContent = authErrorMessage(err);
          msg.classList.add("error");
        }
      };
      card.querySelector("#k-logout").onclick = () => logout();
    }

    unsub = watchAuth(({ user, profile }) => {
      if (!user) return showLogin();
      if (profile?.betaAccess === true) return grant();
      showPending(user);
    });
  });
}
