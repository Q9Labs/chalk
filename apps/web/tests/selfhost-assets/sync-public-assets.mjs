import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const webRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(webRoot, "../..");
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("a clean release serves the previous release's lazy-loaded immutable assets", async () => {
  const assets = await createFixture();
  let runtime;
  try {
    const source = await readFile(join(webRoot, "src/lib/whiteboard-asset-versions.ts"), "utf8");
    const pinned = Object.fromEntries([...source.matchAll(/(\w+_ASSET_(?:VERSION|DIGEST)) = "([^"]+)"/g)].map(([, name, value]) => [name, value]));
    const oldFiles = [`chalk-whiteboard/${pinned.EXCALIDRAW_ASSET_VERSION}-${pinned.EXCALIDRAW_ASSET_DIGEST}/fonts/Assistant/Assistant-Regular.woff2`, `chalk-mathjax/${pinned.MATHJAX_ASSET_VERSION}-${pinned.MATHJAX_ASSET_DIGEST}/tex-svg.js`];
    const oldBytes = await Promise.all(oldFiles.map((path) => readFile(join(webRoot, "public", path))));

    // Only Git inputs survive the fresh checkout used by both release builders.
    const tracked = spawnSync("git", ["ls-files", "-z", "--", "apps/web/immutable-assets"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(tracked.status, 0, tracked.stderr);
    for (const path of tracked.stdout.split("\0").filter(Boolean)) {
      const destination = join(assets.fixture, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(repoRoot, path), destination);
    }
    // The newly installed fixture bytes give both libraries new digest URLs.
    const current = await assets.pinDigests();
    assert.notEqual(current.EXCALIDRAW_ASSET_DIGEST, pinned.EXCALIDRAW_ASSET_DIGEST);
    assert.notEqual(current.MATHJAX_ASSET_DIGEST, pinned.MATHJAX_ASSET_DIGEST);
    runtime = new Miniflare({ modules: true, script: "export default { fetch(request, env) { return env.ASSETS.fetch(request) } }", compatibilityDate: "2026-07-01", assets: { directory: assets.publicDir, binding: "ASSETS" } });
    for (const [index, path] of oldFiles.entries()) {
      const response = await runtime.dispatchFetch(`http://chalk.test/${path}`);
      assert.equal(response.status, 200, `previous release's ${path}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), oldBytes[index]);
    }
  } finally {
    await runtime?.dispose();
    await assets.remove();
  }
});

test("parallel Vite starts publish public assets once, without racing or rewriting served files", async () => {
  const assets = await createFixture();
  try {
    await assets.pinDigests();
    await rm(assets.publicDir, { recursive: true, force: true });
    await assets.sync(8);

    const [whiteboard] = await readdir(join(assets.publicDir, "chalk-whiteboard"));
    const [mathJax] = await readdir(join(assets.publicDir, "chalk-mathjax"));
    // A later server start must not rewrite files an earlier server is already serving.
    // Vite reloads every open page when a public HTML file is rewritten.
    const served = [`chalk-whiteboard/${whiteboard}/fonts/0.woff2`, "privacy-policy/index.html"].map((path) => join(assets.publicDir, path));
    const before = await Promise.all(served.map(async (path) => (await stat(path)).mtimeMs));
    await assets.sync(2);
    assert.deepEqual(await Promise.all(served.map(async (path) => (await stat(path)).mtimeMs)), before);
    assert.deepEqual(await readdir(join(assets.publicDir, "chalk-whiteboard")), [whiteboard]);
    assert.deepEqual(await readdir(join(assets.publicDir, "chalk-mathjax")), [mathJax]);
    assert.equal((await readdir(join(assets.publicDir, `chalk-whiteboard/${whiteboard}/fonts`), { recursive: true })).length, 200);
    assert.equal((await readdir(join(assets.publicDir, `chalk-mathjax/${mathJax}/fonts/mathjax-newcm-font/svg`))).length, 200);
  } finally {
    await assets.remove();
  }
});

test("a same-version dependency patch gets a new asset URL in warm and clean builds", async () => {
  const assets = await createFixture();
  try {
    const whiteboardUrls = () => readdir(join(assets.publicDir, "chalk-whiteboard"));
    const font = (url) => readFile(join(assets.publicDir, "chalk-whiteboard", url, "fonts/0.woff2"), "utf8");
    await assets.pinDigests();
    const [oldUrl] = await whiteboardUrls();
    const oldFont = await font(oldUrl);

    // pnpm patches change installed bytes and keep the package version.
    await writeFile(join(assets.excalidraw, "dist/prod/fonts/0.woff2"), "pnpm-patched-font");
    const [warm] = await assets.sync(1);
    const pinned = await assets.pinDigests();
    const newUrl = (await whiteboardUrls()).find((url) => url !== oldUrl);
    assert.ok(newUrl, "the warm build kept the old bytes behind the only asset URL");
    assert.equal(newUrl, `0.18.1-${pinned.EXCALIDRAW_ASSET_DIGEST}`);
    assert.equal(await font(newUrl), "pnpm-patched-font");
    assert.equal(await font(oldUrl), oldFont);

    await rm(join(assets.publicDir, "chalk-whiteboard"), { recursive: true });
    await assets.pinDigests();
    assert.deepEqual(await whiteboardUrls(), [newUrl]);
    assert.equal(await font(newUrl), "pnpm-patched-font");

    // The build stops until the new digest is pinned, so the app never points at stale bytes.
    assert.notEqual(warm.status, 0);
    assert.match(warm.stderr, /Asset digest mismatch: \/chalk-whiteboard\/0\.18\.1-[0-9a-f]{16} .*EXCALIDRAW_ASSET_DIGEST/);
  } finally {
    await assets.remove();
  }
});

async function createFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "chalk-public-assets-"));
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

  const sync = (count) =>
    Promise.all(
      Array.from({ length: count }, () => {
        const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        return once(child, "close").then(([status]) => ({ status, stderr }));
      }),
    );

  return {
    fixture,
    excalidraw,
    publicDir: join(fixture, "apps/web/public"),
    async sync(count) {
      const results = await sync(count);
      if (count > 1) for (const { status, stderr } of results) assert.equal(status, 0, stderr);
      return results;
    },
    /** Pins the digests the sync reports for the fixture's bytes, the way a developer would. */
    async pinDigests() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [{ status, stderr }] = await sync(1);
        const source = await readFile(versions, "utf8");
        if (status === 0) return Object.fromEntries([...source.matchAll(/(\w+_ASSET_DIGEST) = "([0-9a-f]+)"/g)].map(([, name, digest]) => [name, digest]));
        const mismatch = /set (\w+_ASSET_DIGEST) to "([0-9a-f]+)"/.exec(stderr);
        assert.ok(mismatch, stderr);
        await writeFile(versions, source.replace(new RegExp(`(${mismatch[1]} = ")[0-9a-f]+(")`), `$1${mismatch[2]}$2`));
      }
      assert.fail("sync kept reporting digest mismatches");
    },
    remove: () => rm(fixture, { recursive: true, force: true }),
  };
}

async function writePackage(directory, name, version, main) {
  await mkdir(dirname(join(directory, main)), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, main, version }));
  await writeFile(join(directory, main), "");
}

async function writeFiles(directory, count) {
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, index) => writeFile(join(directory, `${index}.woff2`), "x".repeat(4096))));
}
