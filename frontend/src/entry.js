/**
 * Companion entry. Small on purpose: it pulls in only the access gate (Firebase
 * auth), shows it, and ONLY after the user is signed in + beta-approved does it
 * dynamically import the heavy app (main.js → Three.js, VRM, the render loop).
 *
 * Result: visitors who can't get past the gate never download the 3D bundle.
 * The top-level await needs the es2022 build target (set in vite.config.js).
 */
import "./styles.css";
import { requireAccess } from "./gate.js";

await requireAccess();
await import("./main.js");
