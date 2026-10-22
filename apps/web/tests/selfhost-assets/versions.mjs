import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const webRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(webRoot, "../..");

for (const changed of ["@excalidraw/excalidraw", "mathjax", "@mathjax/mathjax-newcm-font"]) {
  test(`rejects an upgraded ${changed} under an old immutable URL`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "chalk-asset-versions-"));
    try {
      const script = join(fixture, "apps/web/scripts/sync-public-assets.ts");
      const versions = join(fixture, "apps/web/src/lib/whiteboard-asset-versions.ts");
      await mkdir(dirname(script), { recursive: true });
      await mkdir(dirname(versions), { recursive: true });
      await cp(join(webRoot, "scripts/sync-public-assets.ts"), script);
      await cp(join(webRoot, "src/lib/whiteboard-asset-versions.ts"), versions);
      await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
      const packageRoot = join(fixture, "packages/whiteboard");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), "{}");
      for (const name of ["@excalidraw/excalidraw", "mathjax", "@mathjax/mathjax-newcm-font"]) {
        const directory = join(packageRoot, "node_modules", name);
        const main = name === "@excalidraw/excalidraw" ? "dist/prod/index.js" : "index.js";
        await mkdir(dirname(join(directory, main)), { recursive: true });
        const version = name === changed ? "99.0.0" : name === "@excalidraw/excalidraw" ? "0.18.1" : "4.1.3";
        await writeFile(join(directory, "package.json"), JSON.stringify({ name, main, version }));
        await writeFile(join(directory, main), "");
      }
      const result = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Asset version mismatch:/);
      assert.ok(result.stderr.includes(changed), result.stderr);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
