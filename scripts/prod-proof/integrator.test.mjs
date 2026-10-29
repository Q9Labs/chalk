import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { integratorBrowserSource, integratorHandler } from "./integrator.mjs";
import { createIntegratorSession } from "./integrator-session.mjs";

test("manual browser bundle compiles with the SDK and media fixture offline", async () => {
  const { build } = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url))("esbuild");
  const result = await build({
    stdin: {
      contents: integratorBrowserSource({ api: "http://127.0.0.1:1", slug: "fixture" }),
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      sourcefile: "integrator-browser.js",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0);
  assert.ok(result.outputFiles[0].text.length > 0);
});

test("manual HTTP flow prepares both clients before its first lazy access", async (t) => {
  const calls = [];
  const session = createIntegratorSession({
    createEpisode: async () => {
      calls.push("create");
      return { id: "episode" };
    },
    admit: async (_episode, guest) => ({ access: { guest } }),
    refresh: () => assert.fail("not a refresh"),
  });
  let handler;
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = integratorHandler({ session, origin, bundle: "/* local fixture */" });
  const post = (path, body = {}, headers = {}) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { Origin: origin, ...headers },
      body: JSON.stringify(body),
    });
  assert.match(await (await fetch(`${origin}/guest1`)).text(), /button disabled/);
  assert.equal((await post("/ready/1")).status, 204);
  assert.equal((await post("/access/1")).status, 409);
  assert.deepEqual(calls, []);
  assert.equal((await post("/ready/2")).status, 204);
  assert.deepEqual(await (await fetch(`${origin}/status`)).json(), { ready: true });
  assert.deepEqual(calls, [], "loading both pages still must not create an Episode");
  const grants = await Promise.all([post("/access/1"), post("/access/2")]);
  assert.deepEqual(await Promise.all(grants.map((response) => response.json())), [{ guest: 1 }, { guest: 2 }]);
  assert.deepEqual(calls, ["create"]);
  const status = await fetch(`${origin}/status`);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), { ready: true });
});

test("manual HTTP flow rejects foreign origins and malformed access before API calls", async (t) => {
  const session = {
    markReady: () => assert.fail("must not mark ready"),
    getAccess: () => assert.fail("must not call API"),
  };
  let handler;
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = integratorHandler({ session, origin, bundle: "" });
  for (const foreign of [undefined, "https://example.invalid"]) {
    const response = await fetch(`${origin}/ready/1`, { method: "POST", headers: foreign ? { Origin: foreign } : {} });
    assert.equal(response.status, 403);
  }
  for (const body of ["{", "null", '{"replaceMediaConnection":"yes"}']) {
    const response = await fetch(`${origin}/access/1`, { method: "POST", headers: { Origin: origin }, body });
    assert.equal(response.status, 400);
  }
});
