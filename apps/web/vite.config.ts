import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { cloudflare } from "unenv";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

// Use cloudflare_pages preset for Cloudflare Pages deployment
// The runtime error on production is due to Nitro v3 alpha + TanStack Start SSR issues
// TODO: Switch back to SSR once Nitro v3 stabilizes
const config = defineConfig({
	server: {
		port: 3070,
	},
	plugins: [
		nitro({
			preset: "cloudflare_pages",
			unenv: cloudflare,
			// Disable devtools in production to reduce bundle complexity
			rollupConfig: {
				external: process.env.NODE_ENV === "production"
					? ["@tanstack/react-devtools", "@tanstack/react-router-devtools"]
					: [],
			},
		}),
		viteTsConfigPaths({
			projects: ["./tsconfig.json", "../../packages/ui/tsconfig.json"],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});

export default config;
