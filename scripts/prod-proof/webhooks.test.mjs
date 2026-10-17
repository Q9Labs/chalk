import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { createRun } from "./runtime.mjs";
import { prepareIntegration } from "./proofs.mjs";
import { exposeWebhook } from "./webhooks.mjs";
import { cleanupRun } from "./cleanup.mjs";

test("public integration PATCHes and immediately rotates one endpoint; ownership replacement is atomic and preserves the key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "proof-webhook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const calls = [];
  let revision = 1;
  let enabled = false;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    if (path.endsWith("/api-keys") && method === "POST") return Response.json({ api_key: { id: "key" }, secret: "temporary" });
    if (path.endsWith("/tenant")) return Response.json({}, { status: 403 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/token")) return Response.json({ uuid: "catcher" });
    if (path.endsWith("/requests")) return Response.json({ data: [] });
    if (path.endsWith("/rotate-secret")) {
      assert.deepEqual(body, { revoke_previous_immediately: true });
      return Response.json({ revision: ++revision, secret: "rotated-secret" });
    }
    if (method === "PATCH") {
      assert.equal(options.headers["If-Match"], `"${revision}"`);
      enabled = body.enabled;
      return Response.json({ id: "hook", revision: ++revision, enabled });
    }
    if (options.headers?.Authorization === "Bearer temporary") return Response.json({}, { status: 401 });
    assert.ok(path.endsWith("/spaces"), `Unexpected request ${method} ${path}`);
    return Response.json({ spaces: [], pagination: {} });
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
    assert.equal(enabled, true);
    assert.equal(
      calls.some(({ path, method }) => method === "POST" && path.endsWith("/webhook-endpoints")),
      false,
    );
    const patch = calls.find(({ method }) => method === "PATCH");
    assert.equal(patch.body.url, "https://catcher.example.test/catcher");
  } finally {
    await cleanupRun(run);
  }
  assert.equal(enabled, false);
  assert.equal(calls.filter(({ path }) => path.endsWith("/rotate-secret")).length, 2);
  assert.ok(calls.some(({ path, method }) => method === "DELETE" && path === "/token/catcher"));
});
