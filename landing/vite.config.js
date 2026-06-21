import { defineConfig } from "vite";
import { resolve } from "node:path";

// The marketing site + account/beta gate. Runs on its own port so it can sit
// alongside the companion app (which stays on :5173).
//
// - Multi-page: the landing (index.html) and the account dashboard
//   (account.html) are both build entries.
// - server.fs.allow includes the repo root so we can import the shared Firebase
//   config from ../shared (one source of truth for both apps).
export default defineConfig({
  server: {
    port: 5180,
    fs: { allow: [".."] },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        account: resolve(__dirname, "account.html"),
        terms: resolve(__dirname, "terms.html"),
        privacy: resolve(__dirname, "privacy.html"),
      },
    },
  },
});
