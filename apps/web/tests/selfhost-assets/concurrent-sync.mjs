import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const webRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(webRoot, "../..");

test("parallel Vite servers publish whiteboard assets without racing each other", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chalk-asset-race-"));
  try {
    const script = join(fixture, "apps/web/scripts/sync-public-assets.ts");
    await mkdir(dirname(script), { recursive: true });
    await mkdir(join(fixture, "apps/web/src/lib"), { recursive: true });
    await cp(join(webRoot, "scripts/sync-public-assets.ts"), script);
    await cp(join(webRoot, "src/lib/whiteboard-asset-versions.ts"), join(fixture, "apps/web/src/lib/whiteboard-asset-versions.ts"));
    await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    const packageRoot = join(fixture, "packages/whiteboard");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), "{}");
    const excalidraw = join(packageRoot, "node_modules/@excalidraw/excalidraw");
    const mathJax = join(packageRoot, "node_modules/mathjax");
    const mathFont = join(packageRoot, "node_modules/@mathjax/mathjax-newcm-font");
    await writePackage(excalidraw, "@excalidraw/excalidraw", "0.18.1", "dist/prod/index.js");
    await writePackage(mathJax, "mathjax", "4.1.3", "index.js");
    await writePackage(mathFont, "@mathjax/mathjax-newcm-font", "4.1.3", "index.js");
    await writeFile(join(excalidraw, "dist/prod/index.css"), "");
    await writeFiles(join(excalidraw, "dist/prod/fonts"), 200);
    for (const directory of ["input", "output", "a11y", "ui", "sre"]) await writeFiles(join(mathJax, directory), 100);
    await writeFile(join(mathJax, "tex-svg.js"), "");
    await writeFile(join(mathJax, "LICENSE"), "");
    await writeFiles(join(mathFont, "svg"), 200);
    await writeFile(join(mathFont, "svg.js"), "");

    const sync = async (count) => {
      const runs = Array.from({ length: count }, () => {
        const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        return once(child, "close").then(([status]) => ({ status, stderr }));
      });
      for (const { status, stderr } of await Promise.all(runs)) assert.equal(status, 0, stderr);
    };
    await sync(8);

    const publicDir = join(fixture, "apps/web/public");
    // A later server start must not rewrite files an earlier server is already serving.
    const served = join(publicDir, "chalk-whiteboard/0.18.1/fonts/0.woff2");
    const before = (await stat(served)).mtimeMs;
    await sync(2);
    assert.equal((await stat(served)).mtimeMs, before);
    assert.deepEqual((await readdir(join(publicDir, "chalk-whiteboard"))).sort(), ["0.18.1"]);
    assert.deepEqual((await readdir(join(publicDir, "chalk-mathjax"))).sort(), ["4.1.3"]);
    assert.equal((await readdir(join(publicDir, "chalk-whiteboard/0.18.1/fonts"), { recursive: true })).length, 200);
    assert.equal((await readdir(join(publicDir, "chalk-mathjax/4.1.3/fonts/mathjax-newcm-font/svg"))).length, 200);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function writePackage(directory, name, version, main) {
  await mkdir(dirname(join(directory, main)), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, main, version }));
  await writeFile(join(directory, main), "");
}

async function writeFiles(directory, count) {
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, index) => writeFile(join(directory, `${index}.woff2`), "x".repeat(4096))));
}
