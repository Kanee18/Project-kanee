/**
 * Firebase auth + the user's beta-access record.
 *
 * Account model (Firestore):
 *   users/{uid} = { email, displayName, betaAccess: bool, plan, createdAt }
 *
 * Beta access is granted MANUALLY: you flip `betaAccess` to true in the
 * Firestore console for approved users. New accounts start false. The client
 * can read its own doc but security rules forbid it writing `betaAccess`
 * (see SETUP.md), so this gate can't be bypassed from the browser.
 */
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import { firebaseConfig } from "../../shared/firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

/** Create the users/{uid} doc on first sign-in; return the stored profile. */
async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const profile = {
    email: user.email ?? "",
    displayName: user.displayName ?? "",
    betaAccess: false,
    plan: "beta",
    createdAt: serverTimestamp(),
  };
  await setDoc(ref, profile);
  return profile;
}

/**
 * Subscribe to auth changes. The callback receives:
 *   { user, profile }  — profile is the Firestore doc (has betaAccess), or
 *   { user: null, profile: null } when signed out.
 */
export function watchAuth(cb) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) return cb({ user: null, profile: null });
    let profile = null;
    try {
      profile = await ensureUserDoc(user);
    } catch (err) {
      console.warn("could not load profile:", err);
    }
    cb({ user, profile });
  });
}

/** Re-read the signed-in user's Firestore doc (e.g. to check for fresh access). */
export async function refreshProfile() {
  const user = auth.currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists() ? snap.data() : null;
}

export function loginGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export async function signUpEmail(email, password, name) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (name) {
    try {
      await updateProfile(cred.user, { displayName: name });
    } catch {
      /* non-fatal */
    }
  }
  return cred;
}

export function loginEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function logout() {
  return signOut(auth);
}

/** Turn a Firebase error code into a short, human message for a toast. */
export function authErrorMessage(err) {
  const code = err?.code || "";
  switch (code) {
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/missing-password":
      return "Please enter a password.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/email-already-in-use":
      return "That email already has an account — try logging in.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Email or password is incorrect.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in popup — allow popups and retry.";
    case "auth/network-request-failed":
      return "Network error — check your connection and try again.";
    case "auth/configuration-not-found":
    case "auth/operation-not-allowed":
      return "This sign-in method isn't enabled yet in Firebase.";
    default:
      return err?.message?.replace(/^Firebase:\s*/, "") || "Something went wrong.";
  }
}
