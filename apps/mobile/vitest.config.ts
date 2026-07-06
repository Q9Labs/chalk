import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@q9labs/chalk-react-native/clipboard": resolve(configDir, "../../packages/sdk-react-native/src/clipboard.ts"),
      "@q9labs/chalk-react-native/diagnostics": resolve(configDir, "../../packages/sdk-react-native/src/diagnostics.ts"),
      "@q9labs/chalk-react-native/invites": resolve(configDir, "../../packages/sdk-react-native/src/invites.ts"),
      "@q9labs/chalk-react-native/runtime": resolve(configDir, "../../packages/sdk-react-native/src/runtime.ts"),
      "@q9labs/chalk-react-native/storage": resolve(configDir, "../../packages/sdk-react-native/src/storage.ts"),
      "@q9labs/chalk-react-native/theme": resolve(configDir, "../../packages/sdk-react-native/src/ui/theme.ts"),
      "@q9labs/chalk-react-native": resolve(configDir, "../../packages/sdk-react-native/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
