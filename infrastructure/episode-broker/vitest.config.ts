import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const chalkServerSource = fileURLToPath(new URL("../../sdks/typescript/client/src/server/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@q9labsai/chalk-client/server": chalkServerSource,
    },
  },
});
