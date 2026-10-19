import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import callStates from "./vite.call-states.config";

export default mergeConfig(callStates, {
  build: {
    outDir: ".call-performance",
    rollupOptions: { input: fileURLToPath(new URL("./call-states.html", import.meta.url)) },
  },
});
