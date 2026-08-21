import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapLocalSpace } from "./chalk-bootstrap.mjs";

test("bootstrap sends a stable idempotency key when it creates the local Space", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/v1/tenants?page_size=100")) return Response.json({ tenants: [{ id: "tenant-1", name: "Chalk local dev fixture" }] });
    if (String(url).endsWith("/v1/tenants/tenant-1/spaces?page_size=100")) return Response.json({ spaces: [] });
    return Response.json({ id: "space-1", slug: "chalk-local-fixture" }, { status: 201 });
  };

  const result = await bootstrapLocalSpace({ apiOrigin: "http://127.0.0.1:8080", systemToken: "system-token", runtimeId: "runtime-1", fixtureMarker: "fixture", fetchImpl });

  assert.equal(result.spaceId, "space-1");
  const create = requests.find(({ init }) => init.method === "POST");
  assert.equal(create.init.headers["Idempotency-Key"], "chalk-local-space-fixture");
});
