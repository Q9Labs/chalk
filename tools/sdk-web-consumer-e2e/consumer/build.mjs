import { build } from "esbuild";

await build({
  absWorkingDir: import.meta.dirname,
  entryPoints: ["./app.tsx"],
  bundle: true,
  format: "esm",
  outfile: "./dist/bundle.js",
  platform: "browser",
  sourcemap: false,
  target: ["chrome120", "firefox120", "safari17"],
  logLevel: "info",
});
