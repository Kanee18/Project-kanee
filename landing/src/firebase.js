/**
 * Firebase init — shared by the whole landing app. The web config lives in
 * shared/firebase-config.js (one source of truth for both apps).
 */
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { firebaseConfig } from "../../shared/firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/** True until the developer fills in real Firebase credentials. */
export const FIREBASE_CONFIGURED = firebaseConfig.apiKey !== "YOUR_API_KEY";
