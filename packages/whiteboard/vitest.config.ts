import { defineConfig } from "vitest/config";

// Excalidraw's JSON imports need Vite transformation rather than Node loading.
export default defineConfig({ test: { server: { deps: { inline: true } } } });
