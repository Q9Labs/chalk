import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { execSync } from "child_process";
import { fileURLToPath, URL } from "node:url";
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
			{
				find: /^@q9labs\/chalk-core$/,
				replacement: fileURLToPath(new URL("../../packages/sdk-core/src/index.ts", import.meta.url)),
			},
			{
				find: /^@q9labs\/chalk-react$/,
				replacement: fileURLToPath(new URL("../../packages/sdk-react/src/index.ts", import.meta.url)),
			},
			{
				find: /^@q9labs\/chalk-react\/styles\.css$/,
				replacement: fileURLToPath(new URL("../../packages/sdk-react/src/styles/styles.css", import.meta.url)),
			},
			{
				find: /^@q9labs\/chalk-ui$/,
				replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
			},
		],
		dedupe: [
			"react",
			"react-dom",
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
			"@excalidraw/excalidraw",
		],
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
		mdx({
			providerImportSource: "@mdx-js/react",
			remarkPlugins: [remarkGfm],
		}),
		viteReact(),
	],
});

export default config;
