import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import mdx from "@mdx-js/rollup";
import rehypeShiki from "@shikijs/rehype";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execSync } from "child_process";
import pkg from "./package.json";
import sdkReactPkg from "../../sdks/typescript/react/package.json";
import { sourceAliases } from "./vite.aliases";

const commitHash = resolveCommitHash(process.env.CHALK_COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim());
const buildTime = new Date().toISOString();
const configuredWebPort = process.env.CHALK_DEV_WEB_PORT?.trim();
const localWebPort = configuredWebPort ? Number(configuredWebPort) : 3070;
const localWebOrigin = `http://127.0.0.1:${localWebPort}`;
const localAPIOrigin = process.env.CHALK_DEV_API_ORIGIN?.trim() || "http://127.0.0.1:8080";
function resolveCommitHash(configuredHash: string | undefined): string {
  const candidate = configuredHash || execSync("git rev-parse HEAD").toString().trim();
  if (!/^[0-9a-f]{40}$/.test(candidate)) {
    throw new Error(`CHALK_COMMIT_SHA must be a full 40-character lowercase commit SHA; received ${candidate || "unknown"}`);
  }
  return candidate;
}

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
      "/v1": {
        target: localAPIOrigin,
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
    alias: sourceAliases,
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    tsconfigPaths: true,
  },
  plugins: [
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
