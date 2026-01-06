import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

// Use official @cloudflare/vite-plugin for Cloudflare Workers deployment
// This is Cloudflare's recommended approach for TanStack Start
const config = defineConfig({
	server: {
		port: 3070,
	},
	plugins: [
		cloudflare(),
		viteTsConfigPaths({
			projects: ["./tsconfig.json", "../../packages/ui/tsconfig.json"],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});

export default config;
