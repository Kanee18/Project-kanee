import { defineConfig } from "vite";

// - publicDir: the repo-level assets/ folder (character.vrm, animations/*.vrma)
//   is served at the web root, e.g. /character.vrm and /animations/idle_01.vrma.
// - proxy: the backend runs on :8000; proxying /ws keeps client code
//   origin-relative (no hardcoded backend URL).
export default defineConfig({
  publicDir: "../assets",
  build: {
    // es2022 so the entry can use a top-level await for the access gate.
    target: "es2022",
    // The 3D bundle (Three.js + VRM) is a single lazy chunk loaded after the
    // gate; ~850 kB is expected, so quiet the default 500 kB warning.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    // allow importing the shared Firebase config from ../shared
    fs: { allow: [".."] },
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
