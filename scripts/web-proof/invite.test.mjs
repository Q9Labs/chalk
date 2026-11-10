import assert from "node:assert/strict";
import test from "node:test";
import { closeReusedInvite } from "./invite.mjs";

test("closing a reused Space's invite sends a disable request for that Space", async () => {
  const calls = [];
  const run = { tenantPath: "/v1/tenants/t", ownerRequest: async (...call) => calls.push(call) };
  await closeReusedInvite(run, { id: "space-1" });
  assert.deepEqual(calls, [["PATCH", "/v1/tenants/t/spaces/space-1/public-invite", { enabled: false }]]);
});

test("a failed disable request is not swallowed", async () => {
  const run = { tenantPath: "/v1/tenants/t", ownerRequest: async () => Promise.reject(new Error("api down")) };
  await assert.rejects(closeReusedInvite(run, { id: "space-1" }), /api down/);
});
