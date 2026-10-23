import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runAssetScript, setupAssetScripts } from "./fixture.mjs";

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

async function createFixture(scale = 100) {
  const fixture = await mkdtemp(join(tmpdir(), "chalk-public-assets-"));
  const { script, versions, packageRoot } = await setupAssetScripts(fixture);
  const excalidraw = join(packageRoot, "node_modules/@excalidraw/excalidraw");
  const mathJax = join(packageRoot, "node_modules/mathjax");
  const mathFont = join(packageRoot, "node_modules/@mathjax/mathjax-newcm-font");
  await writePackage(excalidraw, "@excalidraw/excalidraw", "0.18.1", "dist/prod/index.js");
  await writePackage(mathJax, "mathjax", "4.1.3", "index.js");
  await writePackage(mathFont, "@mathjax/mathjax-newcm-font", "4.1.3", "index.js");
  await writeFile(join(excalidraw, "dist/prod/index.css"), "");
  await writeFiles(join(excalidraw, "dist/prod/fonts"), scale * 2);
  for (const directory of ["input", "output", "a11y", "ui", "sre"]) await writeFiles(join(mathJax, directory), scale);
  await writeFile(join(mathJax, "tex-svg.js"), "");
  await writeFile(join(mathJax, "LICENSE"), "");
  await writeFiles(join(mathFont, "svg"), scale * 2);
  await writeFile(join(mathFont, "svg.js"), "");

  const sync = (count) => Promise.all(Array.from({ length: count }, () => runAssetScript(script)));

  return {
    fixture,
    excalidraw,
    mathJax,
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
