import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ASSET_MANIFEST, sourceFiles, treeDigest } from "../../scripts/retain-public-assets.ts";

import { runAssetScript } from "./fixture.mjs";

const script = resolve(import.meta.dirname, "../../scripts/retain-public-assets.ts");
const sha = (number) => number.toString(16).padStart(40, "0");

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "chalk-retention-"));
  let live;
  const server = createServer((request, response) => {
    const path = join(live, new URL(request.url, "http://local").pathname);
    if (!existsSync(path)) return response.writeHead(404).end();
    response.writeHead(200).end(readFileSync(path));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(base, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    publish(directory) {
      live = directory;
    },
    build(number, whiteboard = number, mathjax = number) {
      const directory = join(base, String(number));
      const trees = ["chalk-whiteboard", "chalk-mathjax"].map((family, index) => {
        const temporary = join(directory, family, "temporary");
        mkdirSync(temporary, { recursive: true });
        writeFileSync(join(temporary, "asset.js"), `${family} generation ${[whiteboard, mathjax][index]}`);
        const root = `/${family}/1.0.0-${treeDigest(sourceFiles([[temporary, ""]]))}`;
        renameSync(temporary, join(directory, root));
        return { root, files: ["asset.js"] };
      });
      const current = trees.map((tree) => tree.root);
      // releases permits running this regression against the pre-fix schema too.
      writeFileSync(join(directory, ASSET_MANIFEST), JSON.stringify({ format: 1, current, releases: [], generations: current.map((root) => [root]), trees }));
      return directory;
    },
    command(directory, args) {
      return runAssetScript(script, ["--directory", directory, ...args]);
    },
    async retain(directory, number, bootstrap = false) {
      const result = await this.command(directory, ["--origin", origin, "--release", sha(number), ...(bootstrap ? ["--without-asset-retention"] : [])]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(join(directory, ASSET_MANIFEST), "utf8"));
    },
  };
}

test("overlapping B and C read A; C must stop after B publishes", async (t) => {
  const assets = await fixture(t);
  const a = assets.build(1);
  assets.publish(a);
  await assets.retain(a, 1, true);
  const b = assets.build(2);
  const c = assets.build(3);
  const [bm] = await Promise.all([assets.retain(b, 2), assets.retain(c, 3)]);
  assets.publish(b);
  const bAsset = `${assets.origin}${bm.current[0]}/asset.js`;
  assert.equal((await fetch(bAsset)).status, 200);
  const guard = await assets.command(c, ["--check-live"]);
  assert.notEqual(guard.status, 0, "C uploaded its stale retention, discarding B");
  assert.match(guard.stderr, /Live asset manifest changed.*Deploy stopped before upload/);
  assert.equal((await fetch(bAsset)).status, 200);
  // A retry reads B and can publish C while retaining B's actual bytes.
  await assets.retain(c, 3);
  assert.equal((await assets.command(c, ["--check-live"])).status, 0);
  assets.publish(c);
  assert.equal(await (await fetch(bAsset)).text(), "chalk-whiteboard generation 2");
});

test("a missing live manifest requires explicit bootstrap and is checked again before upload", async (t) => {
  const assets = await fixture(t);
  const a = assets.build(1);
  assets.publish(join(a, "missing-site"));
  const routine = await assets.command(a, ["--origin", assets.origin, "--release", sha(1)]);
  assert.notEqual(routine.status, 0);
  assert.match(routine.stderr, /HTTP 404.*--without-asset-retention/);
  await assets.retain(a, 1, true);
  assert.equal((await assets.command(a, ["--check-live"])).status, 0);
  assets.publish(a);
  const changed = await assets.command(a, ["--check-live"]);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Live asset manifest changed/);
});

test("each vendor keeps four distinct generations across releases reusing a digest", async (t) => {
  const assets = await fixture(t);
  const a = assets.build(1);
  assets.publish(a);
  const first = await assets.retain(a, 1, true);
  const aFont = `${assets.origin}${first.current[0]}/asset.js`;
  for (let number = 2; number <= 6; number++) {
    const directory = assets.build(number, 2, number);
    await assets.retain(directory, number);
    assets.publish(directory);
    assert.equal((await fetch(aFont)).status, 200, "repeated whiteboard digest evicted A");
  }
  for (let generation = 3; generation <= 5; generation++) {
    const number = generation + 4;
    const directory = assets.build(number, generation, 6);
    const manifest = await assets.retain(directory, number);
    assets.publish(directory);
    assert.equal((await fetch(aFont)).status, generation === 5 ? 404 : 200);
    assert.deepEqual(
      manifest.generations.map((entries) => entries.length),
      [Math.min(generation, 4), 4],
    );
    assert.equal(manifest.trees.length, Math.min(generation, 4) + 4);
  }
});
