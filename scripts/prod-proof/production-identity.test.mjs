import assert from "node:assert/strict";
import test from "node:test";
import { requireExpectedProductionSha, verifyExpectedProductionSha } from "./production-identity.mjs";

const expectedSha = "a".repeat(40);

test("requires an explicit full lowercase production commit SHA", () => {
  assert.equal(requireExpectedProductionSha({ CHALK_PROOF_EXPECTED_PRODUCTION_SHA: expectedSha }), expectedSha);
  for (const value of [undefined, "", "a".repeat(39), "A".repeat(40)]) {
    assert.throws(
      () => requireExpectedProductionSha({ CHALK_PROOF_EXPECTED_PRODUCTION_SHA: value }),
      /CHALK_PROOF_EXPECTED_PRODUCTION_SHA/,
    );
  }
});

test("accepts a matching live production identity and refuses a mismatch", async () => {
  const fetchIdentity = (commit) => async () => ({
    ok: true,
    json: async () => ({ commit }),
  });

  await verifyExpectedProductionSha(expectedSha, fetchIdentity(expectedSha));
  await assert.rejects(
    verifyExpectedProductionSha(expectedSha, fetchIdentity("b".repeat(40))),
    /does not match/,
  );
});

test("refuses an unavailable production identity", async () => {
  await assert.rejects(
    verifyExpectedProductionSha(expectedSha, async () => ({ ok: false, json: async () => ({}) })),
    /does not match/,
  );
});
