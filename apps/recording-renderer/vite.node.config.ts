import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist/node",
    emptyOutDir: true,
    rollupOptions: {
      external: ["playwright"],
      input: {
        cli: "src/cli.ts",
        fixture: "src/fixture.ts",
        "ui-build-cli": "src/ui-build-cli.ts",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
  resolve: {
    alias: {
      "@q9labsai/recording-presentation": fileURLToPath(new URL("../../packages/recording-presentation/src/index.ts", import.meta.url)),
    },
    tsconfigPaths: true,
  },
  ssr: {
    noExternal: ["@q9labsai/recording-presentation"],
  },
});
