/** Top navigation: brand, section links, and auth state (account menu). */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext.jsx";
import { useUI } from "../ui.jsx";
import { logout } from "../auth.js";
import { CHAT_URL } from "../../../shared/firebase-config.js";
import { Logo, ChevronDown } from "../icons.jsx";

function Avatar({ user }) {
  if (user.photoURL) {
    return (
      <span className="avatar">
        <img src={user.photoURL} alt="" referrerPolicy="no-referrer" />
      </span>
    );
  }
  const ch = (user.displayName || user.email || "K").trim().charAt(0).toUpperCase();
  return <span className="avatar">{ch}</span>;
}

function AccountMenu() {
  const { user, hasAccess } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  return (
    <div className="account" ref={ref}>
      <span className={`badge ${hasAccess ? "ok" : "pending"}`}>
        {hasAccess ? "Beta access" : "Pending"}
      </span>
      <button className="account-btn" onClick={() => setOpen((o) => !o)}>
        <Avatar user={user} />
        <span className="account-name">{user.displayName || user.email}</span>
        <ChevronDown width={16} height={16} />
      </button>
      {open && (
        <div className="menu">
          <Link className="menu-item" to="/account" onClick={() => setOpen(false)}>My account</Link>
          {hasAccess && (
            <button className="menu-item" onClick={() => { window.open(CHAT_URL, "_blank", "noopener"); setOpen(false); }}>
              Open chat
            </button>
          )}
          <button className="menu-item danger" onClick={() => { logout(); setOpen(false); }}>Log out</button>
        </div>
      )}
    </div>
  );
}

export default function Nav() {
  const { user, loading } = useAuth();
  const { openAuth } = useUI();

  return (
    <header className="nav">
      <Link className="brand" to="/">
        <span className="brand-mark"><Logo width={22} height={22} /></span>
        Kanee
      </Link>

      <nav className="nav-links">
        <a href="/#features">Features</a>
        <a href="/#pricing">Pricing</a>
        <a href="/#faq">FAQ</a>
      </nav>

      <div className="nav-auth">
        {loading ? null : user ? (
          <AccountMenu />
        ) : (
          <>
            <button className="btn ghost" onClick={() => openAuth("login")}>Log in</button>
            <button className="btn solid" onClick={() => openAuth("signup")}>Get started</button>
          </>
        )}
      </div>
    </header>
  );
}
