/**
 * Auth state for the whole app: the signed-in user, their Firestore profile
 * (which carries `betaAccess`), and a loading flag while Firebase resolves the
 * initial session.
 */
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase.js";
import { ensureUserDoc, refreshProfile } from "./auth.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          setProfile(await ensureUserDoc(u));
        } catch {
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
  }, []);

  // Re-read the profile (used by "I've been approved — re-check").
  const recheck = useCallback(async () => {
    const fresh = await refreshProfile();
    if (fresh) setProfile(fresh);
    return fresh;
  }, []);

  const hasAccess = profile?.betaAccess === true;

  return (
    <AuthContext.Provider value={{ user, profile, loading, hasAccess, recheck }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
