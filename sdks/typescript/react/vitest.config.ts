import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@q9labsai/chalk-ui/button", replacement: "../../../packages/ui/src/button.tsx" },
      { find: "@q9labsai/chalk-ui/reactions", replacement: "../../../packages/ui/src/reactions.ts" },
      { find: "@q9labsai/facehash/react", replacement: "../../../packages/facehash/src/react.ts" },
      { find: "@q9labsai/facehash", replacement: "../../../packages/facehash/src/index.ts" },
    ],
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 15_000,
  },
});
