import assert from "node:assert/strict";
import test from "node:test";
import { createGatePlan, GatePlanningError } from "./smart-gate.mjs";

function boundaryTask(files, options = {}) {
  return createGatePlan(files, options).tasks.find((task) => task.id === "boundaries");
}

test("application and SDK source changes select the package boundary check", () => {
  for (const file of ["apps/web/src/components/sdk-preview/SdkPreviewGallery.tsx", "sdks/typescript/client/src/sync/v1-client.ts"]) {
    assert.equal(boundaryTask([file])?.selected, true, file);
  }
});

test("documentation-only changes do not select the package boundary check", () => {
  assert.equal(boundaryTask(["docs/contract-codegen.md"])?.selected, false);
});

test("dependency changes select the package boundary check", () => {
  assert.equal(boundaryTask(["pnpm-lock.yaml"])?.selected, true);
});

test("boundary configuration changes fail closed to the full gate", () => {
  for (const file of [".dependency-cruiser.cjs", "gate.config.ts"]) {
    const plan = createGatePlan([file]);
    assert.equal(plan.full, true);
    assert.equal(plan.fullReason, `${file} changes gate behavior`);
    assert.equal(plan.tasks.find((task) => task.id === "boundaries")?.selected, true);
    assert.throws(
      () => createGatePlan([file], { target: "web" }),
      (error) => error instanceof GatePlanningError && error.reason === "full-required",
    );
  }
});
