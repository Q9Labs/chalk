import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticClient } from "../src/client.mjs";
import { resolveOperatorConfig } from "../src/config.mjs";
import { parseReference } from "../src/reference.mjs";

test("accepts canonical production references and rejects the prod alias", () => {
  assert.equal(parseReference("chalkdiag:v1:production:diagnostic-1").environment, "production");
  assert.throws(() => parseReference("chalkdiag:v1:prod:diagnostic-1"), { code: "malformed" });
});

test("resolves production diagnostics only through an HTTPS service origin", async () => {
  const config = await resolveOperatorConfig({ environment: "production", baseUrl: "https://diagnostics.example", credential: "operator-token", fetchImpl: async () => new Response() });
  assert.equal(config.environment, "production");
  assert.equal(config.baseUrl, "https://diagnostics.example");
});

test("requires an operator credential for production diagnostics", async () => {
  await assert.rejects(resolveOperatorConfig({ environment: "production", baseUrl: "https://diagnostics.example", fetchImpl: async () => new Response() }), { code: "invalid_config" });
});

test("keeps localhost diagnostics restricted to loopback origins", async () => {
  await assert.rejects(resolveOperatorConfig({ environment: "localhost", baseUrl: "https://diagnostics.example", fetchImpl: async () => new Response() }), { code: "invalid_config" });
});

test("validates pre-resolved production client configuration", async () => {
  await assert.rejects(createDiagnosticClient({ config: { environment: "production", baseUrl: "https://diagnostics.example", fetchImpl: async () => new Response() } }), { code: "invalid_config" });
  await assert.rejects(createDiagnosticClient({ config: { environment: "production", baseUrl: "http://diagnostics.example", credential: "operator-token", fetchImpl: async () => new Response() } }), { code: "invalid_config" });
});

test("normalizes a null participant projection to an empty array", async () => {
  const client = await createDiagnosticClient({
    config: {
      baseUrl: "https://diagnostics.example",
      environment: "production",
      credential: "operator-token",
      fetchImpl: async () => new Response(JSON.stringify({ participants: null }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  });

  const response = await client.projection("chalkdiag:v1:production:diagnostic-1", "participants");
  assert.deepEqual(response.body.participants, []);
});
