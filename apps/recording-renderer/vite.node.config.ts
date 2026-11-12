import { cp, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { EXCALIDRAW_FONTS } from "./src/compose/excalidraw-fonts.ts";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const nativeExternals = ["@napi-rs/canvas", "happy-dom"];
const excalidrawRoot = dirname(createRequire(source("../../packages/whiteboard/package.json")).resolve("@excalidraw/excalidraw"));

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist/node",
    emptyOutDir: true,
    rollupOptions: {
      external: nativeExternals,
      input: {
        compose: "src/compose-cli.ts",
        "compose-fixture": "src/compose-fixture.ts",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
  plugins: [
    {
      // The compositor paints text without a browser, so it carries its own fonts.
      name: "compose-fonts",
      async closeBundle() {
        const fonts = source("dist/node/fonts");
        await mkdir(join(fonts, "Figtree"), { recursive: true });
        for (const file of await readdir(source("src/compose/font-assets"))) {
          if (file.endsWith(".woff2")) await cp(join(source("src/compose/font-assets"), file), join(fonts, "Figtree", file));
        }
        for (const [folder] of EXCALIDRAW_FONTS) {
          await cp(join(excalidrawRoot, "fonts", folder), join(fonts, "excalidraw", folder), { recursive: true });
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@q9labsai/recording-presentation": source("../../packages/recording-presentation/src/index.ts"),
      "@q9labsai/chalk-react/headless": source("../../sdks/typescript/react/src/headless.ts"),
      "@q9labsai/chalk-whiteboard": source("../../packages/whiteboard/src/index.ts"),
    },
    tsconfigPaths: true,
  },
  ssr: {
    // Bundle transitive dependencies too: chunks resolve imports from the renderer,
    // not from the original package's pnpm dependency directory.
    noExternal: true,
    external: nativeExternals,
  },
});
