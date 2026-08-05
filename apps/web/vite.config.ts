import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";
import pkg from "./package.json";
import sdkReactPkg from "../../sdks/typescript/react/package.json";
import { accountBoundaryVitePlugin } from "./scripts/account-boundary-vite";

const commitHash = execSync("git rev-parse --short HEAD").toString().trim();
const buildTime = new Date().toISOString();
const configuredWebPort = process.env.CHALK_DEV_WEB_PORT?.trim();
const localWebPort = configuredWebPort ? Number(configuredWebPort) : 3070;
const localWebOrigin = `http://127.0.0.1:${localWebPort}`;
const localBrokerPort = process.env.CHALK_DEV_BROKER_PORT?.trim();
const localBrokerTarget = process.env.CHALK_DEV_BROKER_ORIGIN?.trim() || (localBrokerPort ? `http://127.0.0.1:${localBrokerPort}` : "http://127.0.0.1:8787");

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
    host: "127.0.0.1",
    port: localWebPort,
    proxy: {
      "/local-chalk": {
        target: localBrokerTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => {
            proxyRequest.setHeader("origin", localWebOrigin);
          });
        },
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@q9labsai\/chalk-client\/telemetry$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/telemetry/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-client\/effect$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/effect.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-client$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-react\/ui$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/components/ui/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-react$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-ui$/, replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/button", replacement: fileURLToPath(new URL("../../packages/ui/src/button.tsx", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/reactions", replacement: fileURLToPath(new URL("../../packages/ui/src/reactions.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-assets$/, replacement: fileURLToPath(new URL("../../packages/assets/src/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-whiteboard\/react$/, replacement: fileURLToPath(new URL("../../packages/whiteboard/src/react/index.ts", import.meta.url)) },
      { find: "@q9labsai/facehash/react", replacement: fileURLToPath(new URL("../../packages/facehash/src/react.ts", import.meta.url)) },
      { find: "@q9labsai/facehash", replacement: fileURLToPath(new URL("../../packages/facehash/src/index.ts", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    tsconfigPaths: true,
  },
  plugins: [
    accountBoundaryVitePlugin(localWebOrigin),
    tailwindcss(),
    tanstackStart({
      router: {
        routeFileIgnorePattern: "\\.test\\.",
      },
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
});

export default config;
