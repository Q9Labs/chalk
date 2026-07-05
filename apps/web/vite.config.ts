import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { execSync } from "child_process";
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
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json", "../../packages/ui/tsconfig.json"],
    }),
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
