import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "../..");

export async function setupAssetScripts(fixture) {
  const script = join(fixture, "apps/web/scripts/sync-public-assets.ts");
  const versions = join(fixture, "apps/web/src/lib/whiteboard-asset-versions.ts");
  await mkdir(dirname(script), { recursive: true });
  await mkdir(dirname(versions), { recursive: true });
  await cp(join(webRoot, "scripts/sync-public-assets.ts"), script);
  await cp(join(webRoot, "scripts/vendor-asset-files.ts"), join(dirname(script), "vendor-asset-files.ts"));
  await symlink(join(webRoot, "node_modules"), join(fixture, "apps/web/node_modules"), "dir");
  await cp(join(webRoot, "src/lib/whiteboard-asset-versions.ts"), versions);
  await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  const packageRoot = join(fixture, "packages/whiteboard");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), "{}");
  return { script, versions, packageRoot };
}

export async function runAssetScript(script, args = []) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: resolve(webRoot, "../.."), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [status] = await once(child, "close");
  return { status, stderr };
}
