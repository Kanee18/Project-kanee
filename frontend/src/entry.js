/**
 * Companion entry. Gates on sign-in + beta access, discovers the current
 * backend URL (published to Firestore by the tunnel script), THEN loads the
 * heavy app. main.js (Three.js, VRM, render loop) is only fetched after the
 * gate resolves, so nothing heavy downloads for visitors stuck at the gate.
 * The top-level await needs the es2022 build target (set in vite.config.js).
 */
import "./styles.css";
import { requireAccess } from "./gate.js";
import { getBackendUrl } from "./auth.js";
import { setRuntimeBackend } from "./backend.js";

await requireAccess();
try {
  setRuntimeBackend(await getBackendUrl());
} catch {
  /* falls back to ?api / BACKEND_URL / same-origin */
}
await import("./main.js");
