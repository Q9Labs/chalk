import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "js-yaml";

const workflow = load(readFileSync(process.env.RELEASE_WORKFLOW_PATH ?? new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const { jobs } = workflow;

function needs(job) {
  const dependencies = jobs[job].needs ?? [];
  return Array.isArray(dependencies) ? dependencies : [dependencies];
}

function dependsOn(job, dependency, visited = new Set()) {
  if (visited.has(job)) return false;
  visited.add(job);
  return needs(job).some((parent) => parent === dependency || dependsOn(parent, dependency, visited));
}

test("fresh managed deployment must wait for release contracts", () => {
  assert.ok(dependsOn("deploy-managed", "check-managed-contracts"), "deploy-managed must depend on check-managed-contracts");
  assert.ok(needs("publish-managed-manifest").includes("check-managed-contracts"));
  assert.match(jobs["publish-managed-manifest"].if, /needs\.check-managed-contracts\.result == 'success'/);
  assert.match(jobs["prepare-release"].if, /inputs\.manifest_run_id != '' \|\| needs\.publish-managed-manifest\.result == 'success'/);
  assert.match(jobs["deploy-managed"].if, /needs\.prepare-release\.result == 'success'/);
});

test("contracts keep the exact source, arguments and inputs beside both builds", () => {
  const contracts = jobs["check-managed-contracts"];
  assert.deepEqual(needs("check-managed-contracts"), ["plan-managed"]);
  for (const build of ["build-managed-images", "build-media"]) {
    assert.deepEqual(needs(build), ["plan-managed"]);
  }
  const checkout = contracts.steps.find((step) => step.uses === "actions/checkout@v4");
  assert.deepEqual(checkout.with, { ref: "${{ inputs.target_sha }}", "fetch-depth": 0 });
  const checks = contracts.steps.filter((step) => step.run?.includes("scripts/releases/check-contracts.sh"));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].run, "scripts/releases/check-contracts.sh --plan");
  assert.deepEqual(checks[0].env, {
    DEPLOY_MANAGED: "${{ inputs.deploy_managed }}",
    RELEASE_MANAGED: "${{ inputs.release_managed }}",
    MANAGED_ENVIRONMENT: "${{ inputs.managed_environment }}",
  });
  assert.equal(workflow.env.TARGET_SHA, "${{ inputs.target_sha }}");
  assert.ok(!jobs["plan-managed"].steps.some((step) => step.run?.includes("scripts/releases/check-contracts.sh")));
});
