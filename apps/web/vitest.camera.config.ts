import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: configDefaults.exclude,
      include: ["src/call-states/camera-backgrounds.test.ts"],
      maxWorkers: 1,
      server: { deps: { inline: [/open-color/, /@excalidraw/, /packages\/whiteboard/] } },
    },
  }),
);
