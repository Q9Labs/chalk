import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import mdx from "@mdx-js/rollup";
import rehypeShiki from "@shikijs/rehype";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";
import pkg from "./package.json";
import sdkReactPkg from "../../sdks/typescript/react/package.json";
import { accountBoundaryVitePlugin } from "./scripts/account-boundary-vite";
import { isLoopbackHostname, resolveEpisodeDiagnosticsConfig } from "./src/lib/episode-diagnostics-config";

const commitHash = resolveCommitHash(process.env.CHALK_COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim());
const buildTime = new Date().toISOString();
const configuredWebPort = process.env.CHALK_DEV_WEB_PORT?.trim();
const localWebPort = configuredWebPort ? Number(configuredWebPort) : 3070;
const localWebOrigin = `http://127.0.0.1:${localWebPort}`;
const localBrokerPort = process.env.CHALK_DEV_BROKER_PORT?.trim();
const localBrokerTarget = process.env.CHALK_DEV_BROKER_ORIGIN?.trim() || (localBrokerPort ? `http://127.0.0.1:${localBrokerPort}` : "http://127.0.0.1:8787");
const diagnosticsMode = process.env.CHALK_EPISODE_DIAGNOSTICS?.trim();
const diagnosticsEnvironment = process.env.CHALK_ENVIRONMENT?.trim() || (diagnosticsMode === "localhost" ? "localhost" : undefined);
const diagnosticsConfig = resolveEpisodeDiagnosticsConfig(diagnosticsMode, diagnosticsEnvironment, process.env.CHALK_EPISODE_DIAGNOSTICS_GATEWAY, process.env.CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN);

const buildEpisodeDiagnosticsProxy = (environment: NodeJS.ProcessEnv): ProxyOptions | undefined => {
  const mode = environment.CHALK_EPISODE_DIAGNOSTICS?.trim();
  const runtimeEnvironment = environment.CHALK_ENVIRONMENT?.trim() || (mode === "localhost" ? "localhost" : undefined);
  const resolved = resolveEpisodeDiagnosticsConfig(mode, runtimeEnvironment, environment.CHALK_EPISODE_DIAGNOSTICS_GATEWAY, environment.CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN);
  if (resolved.mode !== "localhost") return undefined;

  const operatorToken = environment.CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN?.trim();
  if (!operatorToken) {
    throw new Error("CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN is required for the localhost Episode Diagnostics proxy");
  }

  const target = new URL(environment.CHALK_API_URL?.trim() || "http://127.0.0.1:8080");
  if ((target.protocol !== "http:" && target.protocol !== "https:") || !isLoopbackHostname(target.hostname)) {
    throw new Error("The localhost Episode Diagnostics proxy requires a loopback CHALK_API_URL");
  }

  return {
    target: target.origin,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest) => {
        proxyRequest.setHeader("authorization", `Bearer ${operatorToken}`);
        proxyRequest.setHeader("origin", localWebOrigin);
      });
    },
  };
};

const diagnosticsProxy = buildEpisodeDiagnosticsProxy(process.env);

function resolveCommitHash(configuredHash: string | undefined): string {
  const candidate = configuredHash || execSync("git rev-parse HEAD").toString().trim();
  if (!/^[0-9a-f]{40}$/.test(candidate)) {
    throw new Error(`CHALK_COMMIT_SHA must be a full 40-character lowercase commit SHA; received ${candidate || "unknown"}`);
  }
  return candidate;
}

// SPA mode for Cloudflare Pages deployment
// SSR requires Cloudflare Workers, but our token only has Pages permission
const config = defineConfig({
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __APP_VERSION__: JSON.stringify((pkg as any).version || "0.0.0"),
    __WEB_APP_VERSION__: JSON.stringify((pkg as any).version || "0.0.0"),
    __SDK_REACT_VERSION__: JSON.stringify((sdkReactPkg as any).version || "0.0.0"),
    __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__: JSON.stringify(diagnosticsConfig.enabled),
    __EPISODE_DIAGNOSTICS_MODE__: JSON.stringify(diagnosticsConfig.mode),
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
      ...(diagnosticsProxy ? { "/_internal/episode-diagnostics": diagnosticsProxy } : {}),
    },
  },
  resolve: {
    alias: [
      { find: /^@q9labsai\/chalk-client\/telemetry$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/telemetry/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-client\/effect$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/effect.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-client$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/diagnostics-contracts$/, replacement: fileURLToPath(new URL("../../packages/diagnostics-contracts/src/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-react\/ui$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/components/ui/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-react$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/index.ts", import.meta.url)) },
      { find: /^@q9labsai\/chalk-ui$/, replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/assets", replacement: fileURLToPath(new URL("../../packages/ui/src/assets.ts", import.meta.url)) },
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
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: [
        { path: "/", prerender: { outputPath: "/index.html" } },
        { path: "/status", prerender: { outputPath: "/status/index.html" } },
        { path: "/privacy", prerender: { outputPath: "/privacy/index.html" } },
        { path: "/terms", prerender: { outputPath: "/terms/index.html" } },
      ],
      spa: {
        enabled: true,
        maskPath: "/space",
      },
    }),
    {
      enforce: "pre",
      ...mdx({
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeSlug, [rehypeAutolinkHeadings, { behavior: "append" }], [rehypeShiki, { theme: "github-dark" }]],
      }),
    },
    viteReact(),
  ],
});

export default config;
