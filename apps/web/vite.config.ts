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
