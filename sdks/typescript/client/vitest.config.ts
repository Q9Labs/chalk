import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const diagnosticsContractsSource = fileURLToPath(new URL("../../../packages/diagnostics-contracts/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@q9labsai/diagnostics-contracts": diagnosticsContractsSource,
    },
  },
});
