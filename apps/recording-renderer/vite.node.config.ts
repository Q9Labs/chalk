import { cp, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const excalidrawRoot = dirname(createRequire(source("../../packages/whiteboard/package.json")).resolve("@excalidraw/excalidraw"));

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist/node",
    emptyOutDir: true,
    rollupOptions: {
      external: ["@napi-rs/canvas", "happy-dom"],
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
        for (const folder of ["Excalifont", "Virgil", "Cascadia", "Nunito", "Lilita", "ComicShanns", "Liberation", "Assistant"]) {
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
    noExternal: ["@q9labsai/recording-presentation", "@q9labsai/chalk-react", "@q9labsai/chalk-whiteboard", "@excalidraw/excalidraw", "@hugeicons/core-free-icons"],
  },
});
