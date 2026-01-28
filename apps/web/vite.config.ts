import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

// SPA mode for Cloudflare Pages deployment
// SSR requires Cloudflare Workers, but our token only has Pages permission
const config = defineConfig({
	server: {
		port: 3070,
	},
	resolve: {
		dedupe: [
			"react",
			"react-dom",
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
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
