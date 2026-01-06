import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { cloudflare } from "unenv";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

// Use cloudflare_pages preset with workaround for Nitro v3 SSR issues
// noBundle: true avoids the problematic chunk bundling that breaks module resolution
const config = defineConfig({
	server: {
		port: 3070,
	},
	plugins: [
		nitro({
			preset: "cloudflare_pages",
			unenv: cloudflare,
			// Disable bundling to avoid module resolution issues
			// Each chunk keeps its own imports intact
			minify: false,
			sourceMap: false,
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
