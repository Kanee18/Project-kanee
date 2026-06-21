import { useEffect } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider } from "./AuthContext.jsx";
import { UIProvider, useUI } from "./ui.jsx";
import { FIREBASE_CONFIGURED } from "./firebase.js";
import Nav from "./components/Nav.jsx";
import Footer from "./components/Footer.jsx";
import Home from "./pages/Home.jsx";
import Account from "./pages/Account.jsx";
import Terms from "./pages/Terms.jsx";
import Privacy from "./pages/Privacy.jsx";

function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.querySelector(hash);
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

function ConfigNotice() {
  const { toast } = useUI();
  useEffect(() => {
    if (!FIREBASE_CONFIGURED) {
      toast("Firebase isn't configured yet — fill in shared/firebase-config.js (see SETUP.md).");
    }
  }, [toast]);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <UIProvider>
        <ScrollManager />
        <ConfigNotice />
        <Nav />
        <main>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/account" element={<Account />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Footer />
      </UIProvider>
    </AuthProvider>
  );
}
