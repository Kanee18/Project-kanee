/**
 * Account dashboard (account.html). Requires a signed-in user; if there's no
 * session it bounces back to the landing page (where they can log in).
 *
 * Shows the account, the beta-access state, and the primary action — "Start
 * chat with Kanee" once approved, or a request-access panel while pending.
 */
import "./styles.css";
import { watchAuth, refreshProfile, logout } from "./auth.js";
import { CHAT_URL, BETA_CONTACT } from "../../shared/firebase-config.js";

const dash = document.getElementById("dash");
const contactHref = `mailto:${BETA_CONTACT}?subject=${encodeURIComponent(
  "Kanee beta access request"
)}&body=${encodeURIComponent("Hi! Please grant beta access for: ")}`;

document.getElementById("nav-logout").onclick = () => logout();

function initial(s) {
  return (s || "K").trim().charAt(0).toUpperCase();
}

function render(user, profile) {
  const hasAccess = profile?.betaAccess === true;
  const name = user.displayName || user.email || "there";
  const avatar = user.photoURL
    ? `<span class="avatar"><img src="${user.photoURL}" alt="" referrerpolicy="no-referrer" /></span>`
    : `<span class="avatar">${initial(user.displayName || user.email)}</span>`;

  const actionPanel = hasAccess
    ? `<div class="dash-panel ok">
         <h2>You're in ✨</h2>
         <p>Your beta access is active. Kanee's waiting for you.</p>
         <button class="btn solid lg full" id="start-chat">Start chat with Kanee →</button>
       </div>`
    : `<div class="dash-panel pending">
         <h2>Beta access pending</h2>
         <p>Your account is ready, but access hasn't been granted yet. Reach out and
         we'll unlock it by hand — then come back and re-check.</p>
         <a class="btn solid full" href="${contactHref}">Request access</a>
         <button class="btn ghost full" id="recheck">I've been approved — re-check</button>
       </div>`;

  dash.innerHTML = `
    <div class="dash-card">
      <div class="dash-hi">
        ${avatar}
        <div>
          <h1>Hi, ${name} 👋</h1>
          <p>Welcome to your Kanee account</p>
        </div>
      </div>
      <div class="dash-rows">
        <div class="dash-row"><span class="k">Email</span><span>${user.email || "—"}</span></div>
        <div class="dash-row"><span class="k">Plan</span><span>Beta (free)</span></div>
        <div class="dash-row"><span class="k">Beta access</span>
          <span class="badge ${hasAccess ? "ok" : "pending"}">${hasAccess ? "Active" : "Pending"}</span>
        </div>
      </div>
      ${actionPanel}
      <div class="dash-msg" id="dash-msg"></div>
      <div class="dash-actions">
        <a class="btn ghost" href="/">← Back to home</a>
        <button class="btn ghost" id="signout">Log out</button>
      </div>
    </div>`;

  dash.querySelector("#signout").onclick = () => logout();
  dash.querySelector("#start-chat")?.addEventListener("click", () =>
    window.open(CHAT_URL, "_blank", "noopener")
  );
  dash.querySelector("#recheck")?.addEventListener("click", async (e) => {
    const msg = dash.querySelector("#dash-msg");
    e.target.disabled = true;
    msg.classList.remove("ok");
    msg.textContent = "Checking…";
    try {
      const fresh = await refreshProfile();
      if (fresh?.betaAccess === true) {
        msg.textContent = "Approved! Loading your account…";
        msg.classList.add("ok");
        render(user, fresh);
        return;
      }
      msg.textContent = "Not yet — still pending. Hang tight!";
    } catch {
      msg.textContent = "Couldn't check right now — try again in a moment.";
    } finally {
      e.target.disabled = false;
    }
  });
}

watchAuth(({ user, profile }) => {
  if (!user) {
    location.replace("/"); // no session → go log in on the landing page
    return;
  }
  render(user, profile);
});
