/**
 * Login / sign-up modal. Driven by `mode` ("login" | "signup" | null). Closes
 * itself when Firebase reports a successful sign-in (the AuthProvider picks up
 * the new session and the rest of the UI reacts).
 */
import { useEffect, useState } from "react";
import { loginGoogle, loginEmail, signUpEmail, authErrorMessage } from "../auth.js";
import { Google, Close } from "../icons.jsx";

export default function AuthModal({ mode, onClose }) {
  const open = mode !== null;
  const [tab, setTab] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Sync the active tab to whatever opened the modal; reset fields each open.
  useEffect(() => {
    if (open) {
      setTab(mode);
      setError("");
      setBusy(false);
    }
  }, [open, mode]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isSignup = tab === "signup";

  async function withBusy(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const submit = (e) => {
    e.preventDefault();
    withBusy(() =>
      isSignup ? signUpEmail(email, password, name) : loginEmail(email, password)
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Close width={18} height={18} />
        </button>

        <h2 className="modal-title">{isSignup ? "Create your account" : "Welcome back"}</h2>
        <p className="modal-sub">
          {isSignup ? "Join the Kanee beta in a few seconds." : "Log in to your Kanee account."}
        </p>

        <div className="seg">
          <button className={!isSignup ? "on" : ""} onClick={() => setTab("login")} type="button">Log in</button>
          <button className={isSignup ? "on" : ""} onClick={() => setTab("signup")} type="button">Sign up</button>
        </div>

        <button className="btn google" onClick={() => withBusy(loginGoogle)} disabled={busy} type="button">
          <Google /> Continue with Google
        </button>

        <div className="or"><span>or</span></div>

        <form onSubmit={submit} className="form">
          {isSignup && (
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="What should Kanee call you?" />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={isSignup ? "new-password" : "current-password"} placeholder="••••••••" required />
          </label>
          <button className="btn solid full" type="submit" disabled={busy}>
            {busy ? "Please wait…" : isSignup ? "Create account" : "Log in"}
          </button>
          {error && <p className="form-error">{error}</p>}
        </form>
      </div>
    </div>
  );
}
