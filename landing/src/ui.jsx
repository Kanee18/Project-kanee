/**
 * App-wide UI bits that aren't auth state: the login/signup modal (opened from
 * anywhere via openAuth) and transient toasts.
 */
import { createContext, useContext, useState, useCallback } from "react";
import AuthModal from "./components/AuthModal.jsx";

const UIContext = createContext(null);

export function UIProvider({ children }) {
  const [authMode, setAuthMode] = useState(null); // null | "login" | "signup"
  const [toasts, setToasts] = useState([]);

  const openAuth = useCallback((mode = "login") => setAuthMode(mode), []);
  const closeAuth = useCallback(() => setAuthMode(null), []);

  const toast = useCallback((message, ok = false) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, ok }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  return (
    <UIContext.Provider value={{ openAuth, closeAuth, toast }}>
      {children}
      <AuthModal mode={authMode} onClose={closeAuth} />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.ok ? " ok" : ""}`} onClick={() => dismiss(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </UIContext.Provider>
  );
}

export const useUI = () => useContext(UIContext);
