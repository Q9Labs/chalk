import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("./ui/renderer", import.meta.url));
const override = process.argv[2] ?? process.env.CHALK_HELPER_RENDERER_SOURCE;
const source = override
  ? resolve(override)
  : fileURLToPath(new URL("../../packages/screen-annotation", import.meta.url));
const entry = resolve(source, "src/index.ts");
rmSync(output, { recursive: true, force: true });
if (!existsSync(entry)) {
  console.log("Shared renderer is not in this checkout. Build fixture-only Helper.");
  process.exit(0);
}

mkdirSync(output, { recursive: true });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const bundle = spawnSync(npx, [
  "--yes", "esbuild@0.28.2", entry,
  "--bundle", "--format=esm", "--platform=browser", `--outfile=${resolve(output, "paint.js")}`
], { stdio: "inherit", shell: process.platform === "win32" });
if (bundle.status !== 0) process.exit(bundle.status ?? 1);
cpSync(resolve(source, "fonts"), output, { recursive: true });
