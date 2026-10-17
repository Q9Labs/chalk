import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRun } from "./runtime.mjs";
import { prepareIntegration } from "./proofs.mjs";
import { exposeWebhook } from "./webhooks.mjs";
import { cleanupRun } from "./cleanup.mjs";

test("public integration PATCHes and immediately rotates one endpoint; ownership replacement is atomic and preserves the key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "proof-webhook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const { port } = portProbe.address();
  await new Promise((resolve) => portProbe.close(resolve));
  const calls = [];
  const state = { revision: 1, enabled: false };
  const base = "/v1/tenants/tenant";
  const routes = {
    [`POST ${base}/api-keys`]: () => Response.json({ api_key: { id: "key" }, secret: "temporary" }),
    [`GET ${base}`]: () => Response.json({}, { status: 403 }),
    [`DELETE ${base}/api-keys/key`]: () => new Response(null, { status: 204 }),
    "POST /token": () => Response.json({ uuid: "catcher" }),
    "GET /token/catcher/requests": () => Response.json({ data: [] }),
    "DELETE /token/catcher": () => new Response(null, { status: 204 }),
    [`POST ${base}/webhook-endpoints/hook/rotate-secret`]: (body) => {
      assert.deepEqual(body, { revoke_previous_immediately: true });
      return Response.json({ revision: ++state.revision, secret: "rotated-secret" });
    },
    [`PATCH ${base}/webhook-endpoints/hook`]: (body, options) => {
      assert.equal(options.headers["If-Match"], `"${state.revision}"`);
      state.enabled = body.enabled;
      return Response.json({ id: "hook", revision: ++state.revision, enabled: state.enabled });
    },
    [`GET ${base}/spaces`]: (_body, options) => (options.headers.Authorization === "Bearer temporary" ? Response.json({}, { status: 401 }) : Response.json({ spaces: [], pagination: {} })),
  };
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    const respond = routes[`${method} ${path}`];
    assert.ok(respond, `Unexpected request ${method} ${path}`);
    return respond(body, options);
  });
  const run = await createRun({ api_key: "bootstrap", api_url: "https://api.example.test", tenant_id: "tenant", web_url: "https://web.example.test", proof_origin: `http://127.0.0.1:${port}`, webhook_service_url: "https://catcher.example.test", webhook_endpoint_id: "hook" }, directory);
  try {
    const receiver = await prepareIntegration(run, false);
    assert.equal(JSON.parse(await readFile(`${directory}/ownership.json`)).keyId, "key");
    // A truncated old file must not erase in-memory key ownership. A symlink
    // witness distinguishes atomic replacement from a truncating writeFile.
    await rm(`${directory}/ownership.json`);
    const witness = `${directory}/truncated.json`;
    await writeFile(witness, '{"keyId":');
    await symlink(witness, `${directory}/ownership.json`);
    await exposeWebhook(run, receiver);
    assert.equal(await readFile(witness, "utf8"), '{"keyId":');
    assert.deepEqual(JSON.parse(await readFile(`${directory}/ownership.json`)), { keyId: "key", webhook: { id: "hook", catcherId: "catcher" } });
    assert.equal(state.enabled, true);
    assert.equal(
      calls.some(({ path, method }) => method === "POST" && path.endsWith("/webhook-endpoints")),
      false,
    );
    const patch = calls.find(({ method }) => method === "PATCH");
    assert.equal(patch.body.url, "https://catcher.example.test/catcher");
  } finally {
    await cleanupRun(run);
  }
  assert.equal(state.enabled, false);
  assert.equal(calls.filter(({ path }) => path.endsWith("/rotate-secret")).length, 2);
  assert.ok(calls.some(({ path, method }) => method === "DELETE" && path === "/token/catcher"));
});
