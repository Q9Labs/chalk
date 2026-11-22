import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import callStates from "./vite.call-states.config";

export default mergeConfig(callStates, {
  build: {
    outDir: ".call-performance",
    rollupOptions: { input: fileURLToPath(new URL("./src/call-states/performance.html", import.meta.url)) },
  },
});
