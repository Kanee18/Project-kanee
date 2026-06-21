import { Link } from "react-router-dom";
import { Logo } from "../icons.jsx";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <span className="brand-mark"><Logo width={20} height={20} /></span>
          <span>Kanee</span>
        </div>
        <p className="footer-tag">An expressive 3D AI companion · private beta</p>
        <nav className="footer-links">
          <a href="/#features">Features</a>
          <a href="/#pricing">Pricing</a>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
        </nav>
      </div>
      <div className="footer-base">© {new Date().getFullYear()} Kanee</div>
    </footer>
  );
}
