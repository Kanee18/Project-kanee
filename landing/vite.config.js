import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The marketing site + account/beta gate — now a React SPA (React Router).
// Runs on its own port alongside the companion app (which stays on :5173).
//
// server.fs.allow includes the repo root so we can import the shared Firebase
// config from ../shared (one source of truth for both apps).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    fs: { allow: [".."] },
  },
  build: {
    // Split big vendors into their own chunks so they cache independently
    // (Firebase rarely changes between deploys).
    rollupOptions: {
      output: {
        manualChunks: {
          firebase: ["firebase/app", "firebase/auth", "firebase/firestore"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
