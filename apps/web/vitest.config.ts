import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: configDefaults.exclude,
      maxWorkers: 2,
      server: { deps: { inline: [/open-color/, /@excalidraw/, /packages\/whiteboard/] } },
    },
  }),
);
