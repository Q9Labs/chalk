import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapLocalSpace } from "./chalk-bootstrap.mjs";

test("local bootstrap sends idempotency keys for Space and API-key writes", async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ method: init.method || "GET", path: url.pathname, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "POST" && url.pathname.endsWith("/spaces")) return response(201, { id: "space-1", slug: "chalk-local-fixture" });
    if (init.method === "POST" && url.pathname.endsWith("/api-keys")) return response(201, { api_key: { id: "key-1" }, secret: "broker-secret-value" });
    if (url.pathname === "/v1/tenants") return response(200, { tenants: [{ id: "tenant-1", name: "Chalk local dev fixture" }] });
    if (url.pathname.endsWith("/spaces")) return response(200, { spaces: [] });
    if (url.pathname.endsWith("/api-keys")) return response(200, { api_keys: [] });
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  await bootstrapLocalSpace({
    apiOrigin: "http://127.0.0.1:18080",
    systemToken: "system-token",
    runtimeId: "runtime-id",
    fixtureMarker: "fixture",
    fetchImpl,
  });

  const spaceWrite = requests.find(({ method, path }) => method === "POST" && path.endsWith("/spaces"));
  const apiKeyWrite = requests.find(({ method, path }) => method === "POST" && path.endsWith("/api-keys"));
  assert.equal(spaceWrite.headers["Idempotency-Key"], "chalk-local-space-fixture");
  assert.equal(apiKeyWrite.headers["Idempotency-Key"], "chalk-local-api-key-runtime-id");
  assert.deepEqual(apiKeyWrite.body.scopes, ["episodes:write", "spaces:write"]);
});

test("local bootstrap uses a fresh idempotency key when rotating an existing broker key", async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ method: init.method || "GET", path: url.pathname, headers: init.headers || {} });
    if (init.method === "POST" && url.pathname.endsWith("/rotate")) return response(200, { api_key: { id: "key-1" }, secret: "broker-secret-value" });
    if (url.pathname === "/v1/tenants") return response(200, { tenants: [{ id: "tenant-1", name: "Chalk local dev fixture" }] });
    if (url.pathname.endsWith("/spaces")) return response(200, { spaces: [{ id: "space-1", slug: "chalk-local-fixture" }] });
    if (url.pathname.endsWith("/api-keys")) return response(200, { api_keys: [{ id: "key-1", name: "chalk-local-broker-fixture", revoked_at: null, scopes: ["episodes:write", "spaces:write"] }] });
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  await bootstrapLocalSpace({
    apiOrigin: "http://127.0.0.1:18080",
    systemToken: "system-token",
    runtimeId: "runtime-id",
    fixtureMarker: "fixture",
    fetchImpl,
  });

  const rotation = requests.find(({ method, path }) => method === "POST" && path.endsWith("/rotate"));
  assert.equal(rotation.headers["Idempotency-Key"], "chalk-local-api-key-rotate-runtime-id");
});

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}
