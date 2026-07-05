import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@q9labs/chalk-ui/button", replacement: "../ui/src/button.tsx" },
      { find: "@q9labs/chalk-ui/reactions", replacement: "../ui/src/reactions.ts" },
      { find: "@q9labs/facehash/react", replacement: "../facehash/src/react.ts" },
      { find: "@q9labs/facehash", replacement: "../facehash/src/index.ts" },
    ],
  },
  test: {
    include: ["src/__tests__/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 15_000,
  },
});
