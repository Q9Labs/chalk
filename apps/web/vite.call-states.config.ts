import "./scripts/sync-public-assets";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sourceAliases } from "./vite.aliases";

// Dev server for the call-state harness: every call page state rendered from
// fixtures, so screenshots compare before and after without a live call.
export default defineConfig({
  cacheDir: process.env.CHALK_CALL_HARNESS_CACHE_DIR,
  server: { host: "127.0.0.1", port: Number(process.env.CHALK_CALL_STATES_PORT || 3071), strictPort: true },
  resolve: {
    // The app build uses the board package's compiled output; the harness skips that build step.
    alias: [
      ...sourceAliases,
      { find: /^@q9labsai\/chalk-whiteboard$/, replacement: fileURLToPath(new URL("../../packages/whiteboard/src/index.ts", import.meta.url)) },
      { find: /^\.\.\/\.\.\/lib\/(local-space-client|chalk-access)$/, replacement: fileURLToPath(new URL("./src/call-states/web-space-boundary.ts", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  plugins: [tailwindcss(), viteReact()],
});
