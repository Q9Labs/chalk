import assert from "node:assert/strict";
import test from "node:test";
import { childEnvironment } from "./environment.mjs";

const options = { config: { api_url: "https://api.example", tenant_id: "t", proof_origin: "https://proof.example" }, apiKey: "chalk_sk_x", invite: "/i", directory: "/d", runId: "r", webUrl: "https://web.example" };

test("the e2e child gets the selected media plane, so its SDK guest rejects an overflow to another provider", () => {
  assert.equal(childEnvironment({ PATH: "/bin", CHALK_PROOF_MEDIA_PLANE: "cf_sfu" }, { ...options, mediaPlane: "chalk_sfu" }).CHALK_PROOF_MEDIA_PLANE, "chalk_sfu");
  assert.equal(childEnvironment({ PATH: "/bin" }, { ...options, mediaPlane: "cf_sfu" }).CHALK_PROOF_MEDIA_PLANE, "cf_sfu");
});
