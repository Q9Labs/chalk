import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: configDefaults.exclude,
      // Call journeys each own the same strict-port browser harness.
      maxWorkers: 1,
    },
  }),
);
