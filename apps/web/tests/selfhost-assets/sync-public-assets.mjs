import { strict as assert } from "node:assert";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { runAssetScript, setupAssetScripts } from "./fixture.mjs";

const webRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

const runtimeOptions = { modules: true, script: "export default { fetch(request, env) { return env.ASSETS.fetch(request) } }", compatibilityDate: "2026-07-01", host: "127.0.0.1", port: 0 };
const manifestName = "chalk-asset-manifest.json";
const releaseSHA = (number) => number.toString(16).padStart(40, "0");

async function serve(directory) {
  const runtime = new Miniflare({ ...runtimeOptions, assets: { directory, binding: "ASSETS" } });
  await runtime.ready;
  return runtime;
}

async function manifest(directory) {
  return JSON.parse(await readFile(join(directory, manifestName), "utf8"));
}

test("live-origin retention keeps four distinct generations and expires the oldest", async (t) => {
  const assets = await createFixture(1);
  let runtime;
  const published = [];
  try {
    async function deploy(number) {
      await rm(assets.publicDir, { recursive: true, force: true });
      await writeFile(join(assets.excalidraw, "dist/prod/fonts/0.woff2"), `font release ${number}`);
      await writeFile(join(assets.mathJax, "tex-svg.js"), `math release ${number}`);
      await assets.pinDigests();
      // A warm build's abandoned directory must not leak into a deployment either.
      await mkdir(join(assets.publicDir, "chalk-whiteboard/obsolete"));
      await writeFile(join(assets.publicDir, "chalk-whiteboard/obsolete/old.woff2"), "obsolete");
      const bootstrap = !runtime;
      if (bootstrap) runtime = await serve(assets.publicDir);
      const result = await assets.retain((await runtime.ready).origin, releaseSHA(number), bootstrap);
      assert.equal(result.status, 0, result.stderr);
      const directory = join(assets.fixture, `deployed-${number}`);
      await cp(assets.publicDir, directory, { recursive: true });
      const next = await serve(directory);
      await runtime?.dispose();
      runtime = next;
      const data = await manifest(directory);
      const files = [`${data.current[0]}/fonts/0.woff2`, `${data.current[1]}/tex-svg.js`];
      const bytes = await Promise.all(files.map((path) => readFile(join(directory, path.slice(1)))));
      published.push({ files, bytes });
      assert.equal((await runtime.dispatchFetch("http://chalk.test/chalk-whiteboard/obsolete/old.woff2")).status, 404);
    }
    async function assertServes(number) {
      for (const [index, path] of published[number - 1].files.entries()) {
        const response = await runtime.dispatchFetch(`http://chalk.test${path}`);
        assert.equal(response.status, 200, path);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), published[number - 1].bytes[index]);
      }
    }
    await deploy(1);
    await t.test("A's bytes still serve after clean B and C", async () => {
      await deploy(2);
      await assertServes(1);
      await deploy(3);
      await assertServes(1);
      await assertServes(2);
    });
    await t.test("the fifth distinct generation drops A, while B remains", async () => {
      await deploy(4);
      await assertServes(1);
      await deploy(5);
      for (const path of published[0].files) assert.equal((await runtime.dispatchFetch(`http://chalk.test${path}`)).status, 404, path);
      for (const number of [2, 3, 4, 5]) await assertServes(number);
      const data = await manifest(assets.publicDir);
      assert.deepEqual(
        data.generations.map((entries) => entries.length),
        [4, 4],
      );
      assert.equal(data.trees.length, 8);
      const retry = await assets.retain((await runtime.ready).origin, releaseSHA(5));
      assert.equal(retry.status, 0, retry.stderr);
      assert.deepEqual(await manifest(assets.publicDir), data, "retry consumed a generation slot");
    });
  } finally {
    await runtime?.dispose();
    await assets.remove();
  }
});

test("a fetched tree with the wrong digest stops the deploy before publishing retention", async () => {
  const assets = await createFixture(1);
  let runtime;
  try {
    await assets.pinDigests();
    runtime = await serve(assets.publicDir);
    const initial = await assets.retain((await runtime.ready).origin, releaseSHA(1), true);
    assert.equal(initial.status, 0, initial.stderr);
    const old = await manifest(assets.publicDir);
    const live = join(assets.fixture, "live-corrupted");
    await cp(assets.publicDir, live, { recursive: true });
    await writeFile(join(live, old.current[0], "fonts/0.woff2"), "corrupted origin bytes");
    await runtime.dispose();
    runtime = await serve(live);
    await rm(assets.publicDir, { recursive: true });
    await writeFile(join(assets.excalidraw, "dist/prod/fonts/0.woff2"), "release B");
    await assets.pinDigests();
    const before = await manifest(assets.publicDir);
    const result = await assets.retain((await runtime.ready).origin, releaseSHA(2));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Retained asset digest mismatch:.*deploy stopped/);
    assert.deepEqual(await manifest(assets.publicDir), before);
    assert.deepEqual(await readdir(join(assets.publicDir, "chalk-whiteboard")), [before.current[0].split("/").at(-1)]);
  } finally {
    await runtime?.dispose();
    await assets.remove();
  }
});

test("an unreadable live origin fails closed; the explicit bypass deploys only current trees", async () => {
  const assets = await createFixture(1);
  const runtime = new Miniflare({ ...runtimeOptions, script: 'export default { fetch() { return new Response("offline", { status: 503 }) } }' });
  try {
    const origin = (await runtime.ready).origin;
    await assets.pinDigests();
    const result = await assets.retain(origin, releaseSHA(1));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot retain assets.*HTTP 503.*--without-asset-retention/);
    const bypass = await assets.retain(origin, releaseSHA(1), true);
    assert.equal(bypass.status, 0, bypass.stderr);
    const data = await manifest(assets.publicDir);
    assert.deepEqual(
      data.generations.map((entries) => entries.length),
      [1, 1],
    );
    assert.equal(data.trees.length, 2);
  } finally {
    await runtime.dispose();
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
    retain(origin, release, withoutRetention = false) {
      return runAssetScript(join(dirname(script), "retain-public-assets.ts"), ["--directory", this.publicDir, "--origin", origin, "--release", release, ...(withoutRetention ? ["--without-asset-retention"] : [])]);
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
