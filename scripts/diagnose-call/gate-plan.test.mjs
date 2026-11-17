import assert from "node:assert/strict";
import test from "node:test";
import { createGatePlan } from "../gates/chalk-gate-plan.mjs";

const selected = (files, event) =>
  createGatePlan(files, { scope: "merge base to HEAD", services: "external", event })
    .tasks.filter((task) => task.selected)
    .map((task) => task.id);

test("the call diagnosis runs when the code that writes the rows it reads changes", () => {
  for (const file of [
    "features/media/sfu/internal/media/trail.go",
    "features/media/sfu/internal/telemetry/export.go",
    "apps/api/internal/httpapi/call_stats.go",
    "apps/api/internal/observability/media_replacement.go",
    "sdks/typescript/client/src/connection/report.ts",
    "scripts/diagnose-call/rules.mjs",
  ]) {
    assert.ok(selected([file], "pull_request").includes("diagnose-call"), file);
  }
  assert.ok(!selected(["features/media/sfu/server/main.go"], "pull_request").includes("diagnose-call"));
});
