/**
 * Auth helpers + the user's beta-access record.
 *
 * Account model (Firestore): users/{uid} = { email, displayName, betaAccess,
 * plan, createdAt }. Beta access is granted MANUALLY in the Firestore console;
 * security rules forbid the client writing `betaAccess`, so the gate is safe.
 */
import {
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  signOut,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase.js";

const googleProvider = new GoogleAuthProvider();

/** Create users/{uid} on first sign-in; return the stored profile. */
export async function ensureUserDoc(user) {
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

/** Re-read the signed-in user's doc (e.g. to check for freshly granted access). */
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

/** Turn a Firebase error code into a short, human message. */
export function authErrorMessage(err) {
  switch (err?.code || "") {
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
