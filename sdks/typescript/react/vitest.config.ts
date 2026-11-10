import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@q9labsai/chalk-client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
    },
  },
});
