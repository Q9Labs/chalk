import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapLocalSpace } from "./chalk-bootstrap.mjs";

test("local bootstrap creates a tenant without the removed region field", async () => {
  const requests = [];
  const fixture = await bootstrapLocalSpace({
    apiOrigin: "http://127.0.0.1:8080",
    systemToken: "test-only",
    runtimeId: "share-audio-proof",
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, method: init.method, body });
      if (init.method === "POST") return Response.json({ id: path === "/v1/tenants" ? "tenant" : "space" });
      return Response.json({ tenants: [], spaces: [] });
    },
  });
  const tenant = requests.find((request) => request.path === "/v1/tenants" && request.method === "POST");
  assert.deepEqual(Object.keys(tenant.body).sort(), ["default_media_plane", "media_plane_provider_config", "name"]);
  assert.equal(fixture.tenantId, "tenant");
  assert.equal(fixture.spaceId, "space");
});
