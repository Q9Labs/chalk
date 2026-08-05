import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@q9labsai/chalk-assets": fileURLToPath(new URL("../assets/src/index.ts", import.meta.url)),
    },
  },
});
