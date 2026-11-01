import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

const cameraProof = "src/call-states/camera-backgrounds.test.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: configDefaults.exclude,
      maxWorkers: 2,
      server: { deps: { inline: [/open-color/, /@excalidraw/, /packages\/whiteboard/] } },
      projects: [
        // Software WebGL must not compete with other browser proofs and trigger the real low-FPS fallback.
        { extends: true, test: { name: "camera-backgrounds", include: [cameraProof], sequence: { groupOrder: 0 } } },
        { extends: true, test: { name: "web", exclude: [...configDefaults.exclude, cameraProof], sequence: { groupOrder: 1 } } },
      ],
    },
  }),
);
