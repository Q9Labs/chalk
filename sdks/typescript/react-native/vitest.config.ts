import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@q9labsai/diagnostics-contracts", replacement: fileURLToPath(new URL("../../../packages/diagnostics-contracts/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-client/telemetry", replacement: fileURLToPath(new URL("../client/src/telemetry/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-client/effect", replacement: fileURLToPath(new URL("../client/src/effect.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-client", replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-whiteboard/embedded", replacement: fileURLToPath(new URL("../../../packages/whiteboard/src/embedded/index.ts", import.meta.url)) },
      { find: "@q9labsai/facehash/react-native", replacement: fileURLToPath(new URL("../../../packages/facehash/src/index.native.ts", import.meta.url)) },
    ],
  },
});
