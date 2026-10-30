import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "../../../features/whiteboard/sdk/client/src/**/*.test.{ts,tsx}"],
    typecheck: { enabled: true, tsconfig: "./tsconfig.test-types.json", include: ["src/space-client/error-code-compatibility.test.ts", "src/api-key-error-compatibility.test.ts", "src/space-client/promise-facade.test.ts"] },
  },
  resolve: {
    alias: {},
  },
});
