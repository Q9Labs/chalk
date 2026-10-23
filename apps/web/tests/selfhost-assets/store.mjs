import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { assetFiles, treeDigest } from "../../scripts/vendor-asset-files.ts";
import { uploadVendorAssets } from "../../scripts/upload-vendor-assets.ts";

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const workerPath = resolve(import.meta.dirname, "../../server/vendor-assets.ts");
const script = ts.transpileModule(await readFile(workerPath, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "chalk-vendor-store-"));
  const runtime = new Miniflare({ modules: true, script, r2Buckets: ["VENDOR_ASSETS"], compatibilityDate: "2026-07-01", host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await runtime.dispose();
    await rm(base, { recursive: true, force: true });
  });
  const bucket = await runtime.getR2Bucket("VENDOR_ASSETS");
  const state = { puts: 0, requests: 0, status: 200, release: "A" };
  const prefix = "/accounts/account/r2/buckets/test/objects/";
  // Emulate only Cloudflare's HTTP boundary; the uploader, Worker and R2 are real.
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://local").pathname;
      if (!path.startsWith(prefix)) return response.end(`Pages ${state.release}`);
      state.requests++;
      if (state.status !== 200) return response.writeHead(state.status).end();
      const key = decodeURIComponent(path.slice(prefix.length));
      if (request.method === "GET") {
        const object = await bucket.get(key);
        return response.writeHead(object ? 200 : 404).end(object ? Buffer.from(await object.arrayBuffer()) : undefined);
      }
      assert.equal(request.method, "PUT");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      await bucket.put(key, Buffer.concat(chunks), { httpMetadata: { contentType: request.headers["content-type"], cacheControl: request.headers["cache-control"] } });
      state.puts++;
      response.end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const apiOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    runtime,
    bucket,
    state,
    apiOrigin,
    upload: (directory) => uploadVendorAssets({ directory, bucket: "test", accountId: "account", token: "local-fixture", apiOrigin }),
    async build(number) {
      const directory = join(base, String(number));
      const roots = [];
      for (const family of ["chalk-whiteboard", "chalk-mathjax"]) {
        const staging = join(directory, family, "staging");
        await mkdir(join(staging, "fonts"), { recursive: true });
        await writeFile(join(staging, "asset.js"), `${family} release ${number}`);
        await writeFile(join(staging, "style.css"), "body { color: red }");
        await writeFile(join(staging, "fonts/font.woff2"), "font bytes");
        await writeFile(join(staging, "worker.js"), "self.onmessage = () => postMessage('ready')");
        await writeFile(join(staging, "module.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
        const root = `${family}/1.0.0-${treeDigest(assetFiles([[staging, ""]]))}`;
        await rename(staging, join(directory, root));
        roots.push(root);
      }
      return { directory, roots };
    },
  };
}

test("uploads only missing objects and rejects corrupt bytes before any R2 request", async (t) => {
  const assets = await fixture(t);
  const a = await assets.build(1);
  assert.deepEqual(await assets.upload(a.directory), { uploaded: 10, skipped: 0 });
  assert.deepEqual(await assets.upload(a.directory), { uploaded: 0, skipped: 10 });
  assert.equal(assets.state.puts, 10);
  await writeFile(join(a.directory, a.roots[1], "asset.js"), "same version, changed bytes");
  const before = assets.state.requests;
  await assert.rejects(assets.upload(a.directory), /Vendor asset digest mismatch/);
  assert.equal(assets.state.requests, before);
  const b = await assets.build(2);
  assets.state.status = 403;
  await assert.rejects(assets.upload(b.directory), /R2 lookup.*HTTP 403/);
  assert.equal(assets.state.puts, 10);
});

test("serves exact R2 bytes and MIME types with immutable headers, HEAD, and missing-key 404", async (t) => {
  const assets = await fixture(t);
  const a = await assets.build(1);
  await assets.upload(a.directory);
  for (const root of a.roots) {
    for (const [file, type] of [
      ["asset.js", "text/javascript; charset=utf-8"],
      ["style.css", "text/css; charset=utf-8"],
      ["fonts/font.woff2", "font/woff2"],
      ["worker.js", "text/javascript; charset=utf-8"],
      ["module.wasm", "application/wasm"],
    ]) {
      const url = `https://chalk.test/${root}/${file}`;
      const response = await assets.runtime.dispatchFetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), type);
      assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
      const bytes = await readFile(join(a.directory, root, file));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const head = await assets.runtime.dispatchFetch(url, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal(head.headers.get("Content-Length"), String(bytes.length));
      if (file.endsWith(".wasm")) await WebAssembly.compileStreaming(new Response(bytes, { headers: { "Content-Type": type } }));
    }
    const missing = await assets.runtime.dispatchFetch(`https://chalk.test/${root}/missing.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("Cache-Control"), "no-store");
    assert.equal((await assets.runtime.dispatchFetch(`https://chalk.test/${root}/`)).status, 404);
    assert.equal((await assets.runtime.dispatchFetch(`https://chalk.test/${root}/%`)).status, 400);
    assert.equal((await assets.runtime.dispatchFetch(`https://chalk.test/${root}/asset.js`, { method: "PUT" })).status, 405);
  }
});

test("old digest URLs survive overlapping releases and native rollback to a pre-store Pages snapshot", async (t) => {
  const assets = await fixture(t);
  const a = await assets.build(1);
  await assets.upload(a.directory);
  const b = await assets.build(2);
  const c = await assets.build(3);
  await Promise.all([assets.upload(b.directory), assets.upload(c.directory)]);
  // Release snapshots have no vendor trees or Function. Only the independent Worker keeps them alive.
  for (const release of ["B", "C", "pre-store"]) {
    assets.state.release = release;
    const page = await assets.runtime.dispatchFetch(`${assets.apiOrigin}/chalk-whiteboard/0.18.1/legacy.js`);
    assert.equal(await page.text(), `Pages ${release}`);
    for (const build of [a, b, c]) {
      for (const root of build.roots) {
        const response = await assets.runtime.dispatchFetch(`https://chalk.test/${root}/asset.js`);
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(build.directory, root, "asset.js")));
      }
    }
  }
  const legacy = join(assets.base, "legacy");
  await mkdir(legacy);
  assert.deepEqual(await assets.upload(legacy), { uploaded: 0, skipped: 0 });
  assert.equal((await assets.bucket.list()).objects.length, 30);
});
