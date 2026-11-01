import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requireExpectedProductionSha, verifyExpectedProductionSha } from "./production-identity.mjs";

const expectedSha = "a".repeat(40);

test("requires an explicit full lowercase production commit SHA", () => {
  assert.equal(requireExpectedProductionSha({ CHALK_PROOF_EXPECTED_PRODUCTION_SHA: expectedSha }), expectedSha);
  for (const value of [undefined, "", "a".repeat(39), "A".repeat(40)]) {
    assert.throws(() => requireExpectedProductionSha({ CHALK_PROOF_EXPECTED_PRODUCTION_SHA: value }), /CHALK_PROOF_EXPECTED_PRODUCTION_SHA/);
  }
});

test("accepts a matching live production identity and refuses a mismatch", async () => {
  const fetchIdentity = (commit) => async () => ({
    ok: true,
    json: async () => ({ commit }),
  });

  await verifyExpectedProductionSha(expectedSha, fetchIdentity(expectedSha));
  await assert.rejects(verifyExpectedProductionSha(expectedSha, fetchIdentity("b".repeat(40))), /does not match/);
});

test("refuses an unavailable production identity", async () => {
  await assert.rejects(
    verifyExpectedProductionSha(expectedSha, async () => ({ ok: false, json: async () => ({}) })),
    /does not match/,
  );
});

test("entrypoint reports a missing or invalid expected SHA through its session failure path", () => {
  const entrypoint = fileURLToPath(new URL("./leave-session.mjs", import.meta.url));
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CHALK_PROOF_")));

  for (const expectedSha of [undefined, "invalid"]) {
    const childEnvironment = { ...environment, CHALK_PROOF_CONFIG_SOURCE: "env" };
    if (expectedSha !== undefined) childEnvironment.CHALK_PROOF_EXPECTED_PRODUCTION_SHA = expectedSha;
    const execution = spawnSync(process.execPath, [entrypoint], {
      cwd: repositoryRoot,
      env: childEnvironment,
      encoding: "utf8",
    });

    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 1);
    const sessionReport = JSON.parse(execution.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(sessionReport.result, "failed");
    assert.equal(sessionReport.cleanup, "passed");
    assert.equal(sessionReport.error, undefined);
    assert.doesNotMatch(execution.stdout, /CHALK_PROOF_EXPECTED_PRODUCTION_SHA/);
    assert.match(execution.stderr, /PROOF leave-session: failed \(configuration\)/);
  }
});
