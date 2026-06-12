import { defineConfig } from "vite";

// - publicDir: the repo-level assets/ folder (character.vrm, animations/*.vrma)
//   is served at the web root, e.g. /character.vrm and /animations/idle_01.vrma.
// - proxy: the backend runs on :8000; proxying /ws keeps client code
//   origin-relative (no hardcoded backend URL).
export default defineConfig({
  publicDir: "../assets",
  server: {
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
