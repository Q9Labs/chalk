import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // The camera proof is a demoted check (scripts/gates/checks.json, gate:camera-proof): vitest.camera.config.ts runs it by itself.
      exclude: [...configDefaults.exclude, "src/call-states/camera-backgrounds.test.ts"],
      maxWorkers: 2,
      server: { deps: { inline: [/open-color/, /@excalidraw/, /packages\/whiteboard/] } },
    },
  }),
);
