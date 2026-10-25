import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    typecheck: { enabled: true, tsconfig: "./tsconfig.test-types.json", include: ["src/space-client/error-code-compatibility.test.ts", "src/api-key-error-compatibility.test.ts"] },
  },
  resolve: {
    alias: {},
  },
});
