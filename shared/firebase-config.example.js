/**
 * Firebase web config — SHARED by the landing site and the companion chat app.
 *
 * SETUP (one time):
 *   1. Copy this file to `firebase-config.js` in the same folder.
 *   2. Firebase console → Project settings → General → "Your apps" → Web app →
 *      copy the config object values into `firebaseConfig` below.
 *   3. Enable sign-in providers: Authentication → Sign-in method →
 *      enable "Email/Password" and "Google".
 *   4. Create a Firestore database (production mode) and paste the rules from
 *      SETUP.md.
 *
 * The web config is not a secret (it ships to the browser), but `firebase-config.js`
 * is gitignored so you can keep project-specific values out of the repo.
 */
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

/**
 * Where the companion chat app is served. The landing "Start chat with Kanee"
 * button opens this URL in a new tab. In local dev the Vite companion runs on
 * :5173; in production set this to your deployed chat URL.
 */
export const CHAT_URL = "http://localhost:5173";

/** The marketing/landing site URL. The companion gate links back here. */
export const SITE_URL = "http://localhost:5180";

/** How users without beta access reach you to request it (shown in the UI). */
export const BETA_CONTACT = "ariaakane2@gmail.com";
