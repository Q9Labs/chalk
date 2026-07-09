import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";
import pkg from "./package.json";
import sdkReactPkg from "../../packages/sdk-react/package.json";

const commitHash = execSync("git rev-parse --short HEAD").toString().trim();
const buildTime = new Date().toISOString();

// SPA mode for Cloudflare Pages deployment
// SSR requires Cloudflare Workers, but our token only has Pages permission
const config = defineConfig({
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __APP_VERSION__: JSON.stringify((pkg as any).version || "0.0.0"),
    __WEB_APP_VERSION__: JSON.stringify((pkg as any).version || "0.0.0"),
    __SDK_REACT_VERSION__: JSON.stringify((sdkReactPkg as any).version || "0.0.0"),
  },
  server: {
    port: 3070,
  },
  resolve: {
    alias: [
      { find: "@q9labsai/chalk-ui/button", replacement: fileURLToPath(new URL("../../packages/ui/src/button.tsx", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/reactions", replacement: fileURLToPath(new URL("../../packages/ui/src/reactions.ts", import.meta.url)) },
      { find: "@q9labsai/facehash/react", replacement: fileURLToPath(new URL("../../packages/facehash/src/react.ts", import.meta.url)) },
      { find: "@q9labsai/facehash", replacement: fileURLToPath(new URL("../../packages/facehash/src/index.ts", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
});

export default config;
