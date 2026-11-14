import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import mdx from "@mdx-js/rollup";
import rehypeShiki, { type RehypeShikiOptions } from "@shikijs/rehype";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json";
import { sourceAliases } from "./vite.aliases";
import { selfHostedExcalidraw } from "./scripts/self-hosted-excalidraw";
import { syncPublicAssetsPlugin } from "./scripts/sync-public-assets";

const configuredWebPort = process.env.CHALK_DEV_WEB_PORT?.trim();
const localWebPort = configuredWebPort ? Number(configuredWebPort) : 3070;
const localWebOrigin = `http://127.0.0.1:${localWebPort}`;
const localAPIOrigin = process.env.CHALK_DEV_API_ORIGIN?.trim() || "http://127.0.0.1:8080";
const localSyncOrigin = process.env.CHALK_DEV_SYNC_ORIGIN?.trim() || "http://127.0.0.1:4100";
const publicHost = process.env.PUBLIC_ORIGIN?.trim() ? new URL(process.env.PUBLIC_ORIGIN).hostname : undefined;
// Docs code takes the site's code colors from CSS variables, so one highlight serves both themes.
const docsCodeTheme = {
  name: "chalk-docs",
  type: "dark" as const,
  colors: { "editor.foreground": "var(--chalk-text)", "editor.background": "transparent" },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--code-comment)", fontStyle: "italic" } },
    { scope: ["keyword.control", "keyword.operator.new", "keyword.operator.expression", "storage.type", "storage.modifier", "entity.name.command"], settings: { foreground: "var(--code-keyword)" } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "var(--code-string)" } },
    { scope: ["entity.name.type", "support.class", "entity.name.tag", "support.type.object.module"], settings: { foreground: "var(--code-type)" } },
    { scope: ["storage.type.function.arrow", "meta.template.expression", "meta.embedded"], settings: { foreground: "var(--chalk-text)" } },
  ],
};

const docsShikiOptions = {
  theme: docsCodeTheme,
  // The docs code block shows this as its language label.
  transformers: [
    {
      pre(node) {
        node.properties["data-language"] = this.options.lang;
      },
    },
  ],
} satisfies RehypeShikiOptions;

const config = defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || "0.0.0"),
  },
  build: {
    rolldownOptions: {
      treeshake: {
        manualPureFunctions: ["Schema"],
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: localWebPort,
    // A reverse proxy forwards the public hostname here; Vite rejects hosts it was not told about.
    allowedHosts: publicHost ? [publicHost] : undefined,
    proxy: {
      // Sync's socket shares the public origin, so a browser off this box needs one address for web, API and Sync.
      "/v1/sync": {
        target: localSyncOrigin,
        ws: true,
        changeOrigin: true,
      },
      // The whiteboard socket is Sync's too; without this it falls through to the API, which never upgrades it, so the board never opens.
      // Only the socket itself: the API serves the file downloads under /v1/whiteboard/files.
      "^/v1/whiteboard(\\?.*)?$": {
        target: localSyncOrigin,
        ws: true,
        changeOrigin: true,
      },
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
    syncPublicAssetsPlugin(),
    selfHostedExcalidraw(),
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
        { path: "/privacy/previous", prerender: { outputPath: "/privacy/previous/index.html" } },
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
        rehypePlugins: [rehypeSlug, [rehypeAutolinkHeadings, { behavior: "append" }], [rehypeShiki, docsShikiOptions]],
      }),
    },
    viteReact(),
  ],
});

export default config;
