import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Excalidraw's JSON imports need Vite transformation rather than Node loading.
export default defineConfig({ resolve: { alias: [{ find: "@q9labsai/facehash/react", replacement: fileURLToPath(new URL("../facehash/src/react.ts", import.meta.url)) }] }, test: { server: { deps: { inline: true } } } });
