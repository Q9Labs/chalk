import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@q9labsai/chalk-client/invites", replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/public-invites/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-react-native/invites", replacement: fileURLToPath(new URL("../../sdks/typescript/react-native/src/invites.ts", import.meta.url)) },
    ],
  },
  test: { include: ["src/**/*.test.ts"], maxWorkers: 1 },
});
