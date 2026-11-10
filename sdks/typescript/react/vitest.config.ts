import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Tests resolve the workspace packages from source, so they run without a build first.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@q9labsai/chalk-client", replacement: source("../client/src/index.ts") },
      { find: "@q9labsai/chalk-ui/reactions", replacement: source("../../../packages/ui/src/reactions.ts") },
      { find: "@q9labsai/chalk-ui", replacement: source("../../../packages/ui/src/index.ts") },
      { find: "@q9labsai/chalk-whiteboard/react", replacement: source("../../../packages/whiteboard/src/react/index.ts") },
      { find: "@q9labsai/facehash/react", replacement: source("../../../packages/facehash/src/react.ts") },
    ],
  },
});
