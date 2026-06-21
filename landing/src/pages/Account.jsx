/** Account dashboard. Requires a session; otherwise bounces to home. */
import { useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { useAuth } from "../AuthContext.jsx";
import { logout } from "../auth.js";
import { CHAT_URL, BETA_CONTACT } from "../../../shared/firebase-config.js";
import { ArrowRight } from "../icons.jsx";

const contactHref = `mailto:${BETA_CONTACT}?subject=${encodeURIComponent("Kanee beta access request")}`;

function Avatar({ user }) {
  if (user.photoURL) return <span className="avatar lg"><img src={user.photoURL} alt="" referrerPolicy="no-referrer" /></span>;
  const ch = (user.displayName || user.email || "K").trim().charAt(0).toUpperCase();
  return <span className="avatar lg">{ch}</span>;
}

export default function Account() {
  const { user, hasAccess, loading, recheck } = useAuth();
  const [msg, setMsg] = useState("");
  const [checking, setChecking] = useState(false);

  if (loading) return <div className="page-center"><div className="spinner" /></div>;
  if (!user) return <Navigate to="/" replace />;

  async function onRecheck() {
    setChecking(true);
    setMsg("Checking…");
    try {
      const fresh = await recheck();
      setMsg(fresh?.betaAccess ? "Approved! You're in." : "Not yet — still pending. Hang tight!");
    } catch {
      setMsg("Couldn't check right now — try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="page-center">
      <div className="dash-card">
        <div className="dash-hi">
          <Avatar user={user} />
          <div>
            <h1>Hi, {user.displayName || user.email} 👋</h1>
            <p>Welcome to your Kanee account</p>
          </div>
        </div>

        <div className="dash-rows">
          <div className="dash-row"><span className="k">Email</span><span>{user.email || "—"}</span></div>
          <div className="dash-row"><span className="k">Plan</span><span>Beta (free)</span></div>
          <div className="dash-row">
            <span className="k">Beta access</span>
            <span className={`badge ${hasAccess ? "ok" : "pending"}`}>{hasAccess ? "Active" : "Pending"}</span>
          </div>
        </div>

        {hasAccess ? (
          <div className="dash-panel ok">
            <h2>You're in</h2>
            <p>Your beta access is active. Kanee's waiting for you.</p>
            <button className="btn solid full" onClick={() => window.open(CHAT_URL, "_blank", "noopener")}>
              Start chat with Kanee <ArrowRight width={18} height={18} />
            </button>
          </div>
        ) : (
          <div className="dash-panel pending">
            <h2>Beta access pending</h2>
            <p>Your account is ready, but access hasn't been granted yet. Reach out and we'll unlock it by hand — then re-check.</p>
            <a className="btn solid full" href={contactHref}>Request access</a>
            <button className="btn ghost full" onClick={onRecheck} disabled={checking}>
              {checking ? "Checking…" : "I've been approved — re-check"}
            </button>
          </div>
        )}

        {msg && <p className="dash-msg">{msg}</p>}

        <div className="dash-actions">
          <Link className="btn ghost" to="/">← Back to home</Link>
          <button className="btn ghost" onClick={() => logout()}>Log out</button>
        </div>
      </div>
    </div>
  );
}
