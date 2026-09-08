import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  plugins: [
    tailwindcss(),
    react(),
    {
      name: "recording-whiteboard-css",
      async closeBundle() {
        const outputPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist/client/excalidraw.css");
        await copyFile(fileURLToPath(new URL("../../packages/whiteboard/node_modules/@excalidraw/excalidraw/dist/prod/index.css", import.meta.url)), outputPath);
      },
    },
  ],
  resolve: {
    alias: [
      { find: "@q9labsai/chalk-assets", replacement: fileURLToPath(new URL("../../packages/assets/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/diagnostics-contracts", replacement: fileURLToPath(new URL("../../packages/diagnostics-contracts/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/reactions", replacement: fileURLToPath(new URL("../../packages/ui/src/reactions.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-ui/assets", replacement: fileURLToPath(new URL("../../packages/ui/src/assets.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-ui", replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-whiteboard/react", replacement: fileURLToPath(new URL("../../packages/whiteboard/src/react/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-whiteboard", replacement: fileURLToPath(new URL("../../packages/whiteboard/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-client", replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/facehash/react", replacement: fileURLToPath(new URL("../../packages/facehash/src/react.ts", import.meta.url)) },
      { find: "@q9labsai/facehash", replacement: fileURLToPath(new URL("../../packages/facehash/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/recording-presentation", replacement: fileURLToPath(new URL("../../packages/recording-presentation/src/index.ts", import.meta.url)) },
      { find: "@q9labsai/chalk-react", replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/index.ts", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    tsconfigPaths: true,
  },
});
