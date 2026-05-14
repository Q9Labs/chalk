import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@q9labs/chalk-core": resolve(configDir, "../../packages/sdk-core/src/index.ts"),
      "@q9labs/chalk-react-native": resolve(configDir, "../../packages/sdk-react-native/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
