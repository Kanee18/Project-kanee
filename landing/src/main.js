/**
 * Landing site behaviour: auth dialog (Google + email/password), account menu,
 * and the beta-gated call-to-action.
 *
 * CTA states:
 *   signed out          → "Request beta access" (opens the signup dialog)
 *   signed in, no access → "Awaiting approval" + a contact link
 *   signed in + access   → "Start chat with Kanee" (opens the companion app)
 */
import "./styles.css";
import {
  watchAuth,
  loginGoogle,
  loginEmail,
  signUpEmail,
  logout,
  authErrorMessage,
} from "./auth.js";
import { CHAT_URL, BETA_CONTACT, firebaseConfig } from "../../shared/firebase-config.js";

const $ = (sel, root = document) => root.querySelector(sel);

// -- small helpers -----------------------------------------------------------

function toast(message, ok = false) {
  const el = document.createElement("div");
  el.className = `toast${ok ? " ok" : ""}`;
  el.textContent = message;
  el.onclick = () => el.remove();
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function openChat() {
  window.open(CHAT_URL, "_blank", "noopener");
}

const contactHref = `mailto:${BETA_CONTACT}?subject=${encodeURIComponent(
  "Kanee beta access request"
)}&body=${encodeURIComponent("Hi! I'd love to try Kanee. My account email is: ")}`;

// -- auth dialog -------------------------------------------------------------

const dialog = $("#auth-dialog");
const form = $("#auth-form");
const foot = $("#auth-foot");
let mode = "login"; // "login" | "signup"

function setMode(next) {
  mode = next;
  $$(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === mode));
  $("[data-only='signup']").hidden = mode !== "signup";
  $("#auth-submit").textContent = mode === "signup" ? "Create account" : "Log in";
  $("#auth-password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  foot.textContent = "";
  foot.classList.remove("error");
}

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function openAuth(next = "login") {
  setMode(next);
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $("#auth-email").focus(), 50);
}

function closeAuth() {
  if (dialog.open) dialog.close();
}

$$(".auth-tab").forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.tab)));

// close when clicking the backdrop (outside the card)
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) closeAuth();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const name = $("#auth-name").value.trim();
  const submit = $("#auth-submit");
  submit.disabled = true;
  foot.classList.remove("error");
  foot.textContent = mode === "signup" ? "Creating your account…" : "Signing in…";
  try {
    if (mode === "signup") await signUpEmail(email, password, name);
    else await loginEmail(email, password);
    closeAuth();
  } catch (err) {
    foot.textContent = authErrorMessage(err);
    foot.classList.add("error");
  } finally {
    submit.disabled = false;
  }
});

// -- global click delegation (data-action buttons, incl. dynamic CTA) --------

document.addEventListener("click", async (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  switch (action) {
    case "login":
      openAuth("login");
      break;
    case "signup":
      openAuth("signup");
      break;
    case "close-auth":
      closeAuth();
      break;
    case "google":
      try {
        await loginGoogle();
        closeAuth();
      } catch (err) {
        foot.textContent = authErrorMessage(err);
        foot.classList.add("error");
      }
      break;
    case "open-chat":
      openChat();
      $("#account-pop").hidden = true;
      break;
    case "logout":
      await logout();
      $("#account-pop").hidden = true;
      toast("Signed out.");
      break;
  }
});

// -- account menu (popover) --------------------------------------------------

$("#account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("#account-pop");
  pop.hidden = !pop.hidden;
});
document.addEventListener("click", (e) => {
  const pop = $("#account-pop");
  if (!pop.hidden && !e.target.closest("#account-menu")) pop.hidden = true;
});

// -- render auth state -------------------------------------------------------

const heroCta = $("#hero-cta");
const heroNote = $("#hero-note");
const betaStatus = $("#beta-status");
const betaContact = $("#beta-contact");
betaContact.href = contactHref;

function renderSignedOut() {
  $("[data-auth='out']").hidden = false;
  $("[data-auth='in']").hidden = true;
  heroCta.innerHTML = `
    <button class="btn solid lg" data-action="signup">Request beta access</button>
    <a class="btn ghost lg" href="#features">See what she does</a>`;
  heroNote.textContent = "Free while in beta · no card required";
  betaStatus.textContent = "";
  betaStatus.className = "beta-small";
}

function renderSignedIn(user, profile) {
  $("[data-auth='out']").hidden = true;
  $("[data-auth='in']").hidden = false;

  // account chip
  $("#account-email").textContent = user.displayName || user.email || "Account";
  const avatar = $("#account-avatar");
  if (user.photoURL) {
    avatar.innerHTML = `<img src="${user.photoURL}" alt="" referrerpolicy="no-referrer" />`;
  } else {
    avatar.textContent = (user.displayName || user.email || "K").trim().charAt(0).toUpperCase();
  }

  const hasAccess = profile?.betaAccess === true;
  const badge = $("#access-badge");
  if (hasAccess) {
    badge.textContent = "Beta access";
    badge.className = "badge ok";
    heroCta.innerHTML = `
      <button class="btn solid lg" data-action="open-chat">Start chat with Kanee →</button>
      <a class="btn ghost lg" href="#features">What's new</a>`;
    heroNote.textContent = "You're in. Have fun ♥";
    betaStatus.textContent = "✓ Your beta access is active — the chat button is unlocked.";
    betaStatus.className = "beta-small ok";
  } else {
    badge.textContent = "Pending approval";
    badge.className = "badge pending";
    heroCta.innerHTML = `
      <button class="btn solid lg" disabled>Awaiting beta approval</button>
      <a class="btn ghost lg" href="${contactHref}">Contact for access</a>`;
    heroNote.textContent = "Your account is created — request access to unlock the chat.";
    betaStatus.textContent = "Your account is pending. Contact us and we'll grant access by hand.";
    betaStatus.className = "beta-small pending";
  }
}

watchAuth(({ user, profile }) => {
  if (user) renderSignedIn(user, profile);
  else renderSignedOut();
});

// -- misc --------------------------------------------------------------------

$("#year").textContent = new Date().getFullYear();

// Friendly nudge if the Firebase config hasn't been filled in yet.
if (firebaseConfig.apiKey === "YOUR_API_KEY") {
  toast("Firebase isn't configured yet — fill in shared/firebase-config.js (see SETUP.md).");
}
