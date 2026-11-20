import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Windows timers tick every 15 ms, so tests that advance simulated minutes with real zero-delay waits run several times slower there.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    setupFiles: [fileURLToPath(new URL("../../../scripts/test/no-network.mjs", import.meta.url))],
  },
});
