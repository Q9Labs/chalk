import assert from "node:assert/strict";
import test from "node:test";
import { childEnvironment } from "./environment.mjs";

const options = { config: { api_url: "https://api.example", tenant_id: "t", proof_origin: "https://proof.example" }, apiKey: "chalk_sk_x", invite: "/i", directory: "/d", runId: "r", webUrl: "https://web.example" };

test("the proof child reaches the stack database a browser journey switches settings in", () => {
  const url = "postgres://postgres:p@127.0.0.1:5432/chalk?sslmode=disable";
  assert.equal(childEnvironment({ PATH: "/bin", CHALK_DATABASE_URL: url }, options).CHALK_DATABASE_URL, url);
});

test("the proof child does not inherit a retired media-plane override", () => {
  const child = childEnvironment({ PATH: "/bin", CHALK_PROOF_MEDIA_PLANE: "cf_sfu" }, options);
  assert.equal(child.CHALK_PROOF_MEDIA_PLANE, undefined);
  assert.equal(child.CHALK_E2E_INVITE, options.invite);
});
