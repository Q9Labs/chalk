import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@q9labsai/chalk-react-native/clipboard": resolve(configDir, "../../sdks/typescript/react-native/src/clipboard.ts"),
      "@q9labsai/chalk-react-native/diagnostics": resolve(configDir, "../../sdks/typescript/react-native/src/diagnostics.ts"),
      "@q9labsai/chalk-react-native/invites": resolve(configDir, "../../sdks/typescript/react-native/src/invites.ts"),
      "@q9labsai/chalk-react-native/runtime": resolve(configDir, "../../sdks/typescript/react-native/src/runtime.ts"),
      "@q9labsai/chalk-react-native/storage": resolve(configDir, "../../sdks/typescript/react-native/src/storage.ts"),
      "@q9labsai/chalk-react-native/theme": resolve(configDir, "../../sdks/typescript/react-native/src/ui/theme.ts"),
      "@q9labsai/chalk-react-native": resolve(configDir, "../../sdks/typescript/react-native/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
