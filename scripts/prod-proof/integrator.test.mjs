import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createIntegratorAccessSession, integratorBrowserSource, integratorHandler } from "./integrator.mjs";
import { prepareBrowser } from "./integrator-browser.mjs";
import { createIntegratorSession } from "./integrator-session.mjs";

test("server forwards conditional replacement context to SDK issueAccess", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-integrator-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issued = [];
  const run = {
    directory,
    runId: "fixture",
    tenantPath: "/fixture",
    apiRequest: async () => ({ id: "episode" }),
  };
  const chalk = {
    participants: {
      admit: async () => ({ participant: { id: "participant" }, access: { generation: 1 } }),
      issueAccess: async (...args) => {
        issued.push(args);
        return { generation: 2 };
      },
    },
  };
  const session = createIntegratorAccessSession(run, { id: "space" }, chalk, (access) => ({ generation: access.generation }));
  session.markReady(1);
  session.markReady(2);
  await session.getAccess(1, { reason: "join" });
  const recovery = { replaceMediaConnection: true, expectedMediaConnectionId: "original-connection", currentMediaToken: "private-recovery-token" };
  assert.deepEqual(await session.getAccess(1, { reason: "retry", ...recovery }), { generation: 2 });
  assert.deepEqual(issued, [["space", "episode", "participant", { generation: 1 }, recovery]]);
});

test("browser forwards media recovery guards without retaining their values in receipts", async (t) => {
  const window = {};
  const element = {};
  let getAccess;
  let posted;
  const globals = {
    window,
    location: { pathname: "/guest1" },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    document: { querySelector: () => element },
    fetch: async (path, options) => {
      if (path === "/ready/1") return new Response(null, { status: 204 });
      if (path === "/status") return Response.json({ ready: true });
      assert.equal(path, "/access/1");
      posted = JSON.parse(options.body);
      return Response.json({ media: { expires_at: "media-expiry" }, sync: { expires_at: "sync-expiry" } });
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  await prepareBrowser(
    (options) => {
      getAccess = options.getAccess;
      return { subscribe() {} };
    },
    () => {},
    { slug: "fixture", api: "http://127.0.0.1:1" },
  );
  await window.proofReady;
  const input = {
    reason: "retry",
    replaceMediaConnection: true,
    expectedMediaConnectionId: "original-connection",
    currentMediaToken: "private-recovery-token",
  };
  await getAccess(input);
  assert.deepEqual(posted, input);
  assert.equal(Object.hasOwn(window.proofAccessCalls[0], "currentMediaToken"), false);
  assert.equal(Object.hasOwn(window.proofAccessCalls[0], "expectedMediaConnectionId"), false);
  assert.ok(!JSON.stringify(window.proofAccessCalls).includes(input.currentMediaToken));
});

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

test("manual HTTP flow gates first access and forwards recovery guards to refresh", async (t) => {
  const calls = [];
  const refreshes = [];
  const session = createIntegratorSession({
    createEpisode: async () => {
      calls.push("create");
      return { id: "episode" };
    },
    admit: async (_episode, guest) => ({ access: { guest } }),
    refresh: async (_episode, _admission, input) => {
      refreshes.push(input);
      return { refreshed: true };
    },
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
  const recovery = { reason: "retry", replaceMediaConnection: true, expectedMediaConnectionId: "original-connection", currentMediaToken: "private-recovery-token" };
  assert.deepEqual(await (await post("/access/1", recovery)).json(), { refreshed: true });
  assert.deepEqual(refreshes, [recovery]);
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
  for (const body of ["{", "null", '{"replaceMediaConnection":"yes"}', '{"expectedMediaConnectionId":42}', '{"expectedMediaConnectionId":null}', '{"currentMediaToken":42}', '{"currentMediaToken":null}']) {
    const response = await fetch(`${origin}/access/1`, { method: "POST", headers: { Origin: origin }, body });
    assert.equal(response.status, 400);
  }
});
