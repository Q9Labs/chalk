import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@q9labsai/chalk-whiteboard/react", replacement: fileURLToPath(new URL("../../../packages/whiteboard/src/react/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/button", replacement: fileURLToPath(new URL("../../../packages/ui/src/button.tsx", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/reactions", replacement: fileURLToPath(new URL("../../../packages/ui/src/reactions.ts", import.meta.url)) },
      { find: "@q9labsai/facehash/react", replacement: fileURLToPath(new URL("../../../packages/facehash/src/react.ts", import.meta.url)) },
      { find: "@q9labsai/facehash", replacement: fileURLToPath(new URL("../../../packages/facehash/src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 15_000,
  },
});
