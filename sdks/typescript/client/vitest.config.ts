import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL("../../../scripts/test/no-network.mjs", import.meta.url))],
    typecheck: { enabled: true, tsconfig: "./tsconfig.test-types.json", include: ["src/space-client/error-code-compatibility.test.ts", "src/space-client/promise-facade.test.ts"] },
  },
});
