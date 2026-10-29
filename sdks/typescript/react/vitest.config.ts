import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";
const sources = [
  ["@q9labsai/chalk-client/effect", "../client/src/effect.ts"],
  ["@q9labsai/chalk-client", "../client/src/index.ts"],
  ["@q9labsai/chalk-ui/reactions", "../../../packages/ui/src/reactions.ts"],
  ["@q9labsai/chalk-ui/assets", "../../../packages/ui/src/assets.ts"],
  ["@q9labsai/chalk-ui/button", "../../../packages/ui/src/button.tsx"],
  ["@q9labsai/chalk-ui", "../../../packages/ui/src/index.ts"],
  ["@q9labsai/chalk-assets", "../../../packages/assets/src/index.ts"],
  ["@q9labsai/chalk-whiteboard/react", "../../../features/whiteboard/packages/canvas/src/react/index.ts"],
  ["@q9labsai/chalk-whiteboard", "../../../features/whiteboard/packages/canvas/src/index.ts"],
  ["@q9labsai/facehash/react", "../../../packages/facehash/src/react.ts"],
  ["@q9labsai/facehash", "../../../packages/facehash/src/index.ts"],
] as const;
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "../../../features/whiteboard/sdk/react/src/**/*.test.{ts,tsx}"], setupFiles: ["./tests/setup.ts"], server: { deps: { inline: true } } },
  resolve: {
    alias: [
      ...sources.map(([find, source]) => ({ find, replacement: fileURLToPath(new URL(source, import.meta.url)) })),
      { find: "@excalidraw/excalidraw", replacement: createRequire(new URL("../../../features/whiteboard/packages/canvas/package.json", import.meta.url)).resolve("@excalidraw/excalidraw") },
    ],
  },
});
