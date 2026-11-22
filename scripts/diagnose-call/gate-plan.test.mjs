import assert from "node:assert/strict";
import test from "node:test";
import { ciJobs, createGatePlan, laneGroup } from "../gates/chalk-gate-plan.mjs";

const selected = (files, event) =>
  createGatePlan(files, { scope: "merge base to HEAD", services: "external", event })
    .tasks.filter((task) => task.selected)
    .map((task) => task.id);

test("the call diagnosis runs when the code that writes the rows it reads changes", () => {
  for (const file of [
    "features/media/sfu/internal/media/trail.go",
    "features/media/sfu/internal/telemetry/export.go",
    "features/media/sfu/internal/media/stats.go",
    "features/media/sfu/internal/media/unmute.go",
    "features/media/sfu/internal/media/outcome.go",
    "apps/api/internal/adapters/postgres/session_outcomes.go",
    "apps/api/internal/adapters/postgres/plane_audit.go",
    "apps/api/internal/httpapi/call_stats.go",
    "apps/api/internal/observability/media_replacement.go",
    "sdks/typescript/client/src/connection/report.ts",
    "scripts/diagnose-call/rules.mjs",
  ]) {
    assert.ok(selected([file], "pull_request").includes("diagnose-call"), file);
  }
  assert.ok(!selected(["features/media/sfu/server/main.go"], "pull_request").includes("diagnose-call"));
});

test("the coverage gate runs in the call diagnosis lane for a fault scenario, an emit site or a chain hop's test, and an observability edit runs every hop", () => {
  for (const file of [
    "sdks/typescript/client/src/connection/end-wrong-screen.fault.test.ts",
    "sdks/typescript/client/src/connection/lifecycle.ts",
    "apps/sync/lib/chalk_sync/stateholder/postgres/webhook_observation.ex",
    "apps/api/internal/httpapi/telemetry_chain_test.go",
    "apps/sync/test/chalk_sync/obs_chain_test.exs",
  ]) {
    assert.ok(selected([file], "pull_request").includes("diagnose-call"), file);
  }
  const lane = createGatePlan(["scripts/diagnose-call/rules.mjs"], { scope: "merge base to HEAD", services: "external" }).tasks.find((task) => task.id === "diagnose-call");
  assert.ok(lane.command.includes("scripts/gates/obs-coverage.mjs") && lane.command.includes("scripts/gates/obs-coverage.test.mjs"));
  assert.equal(laneGroup("diagnose-call"), "checks");
  // Each hop compares what it writes with the committed hand-off, so a stale chain file fails the hop in its own lane: the SDK's tests,
  // the API gate, the Sync gate and this lane. observability/ is unclassified, so its edits select all of them.
  const chain = ciJobs(["observability/fixtures/end.wrong_screen/chain/api-rows.positive.json"], { event: "pull_request" });
  assert.equal(chain.planFull, true);
  assert.equal(chain.api && chain.sync, true);
  assert.ok(["tests", "diagnose-call"].every((id) => selected(["observability/fixtures/end.wrong_screen/chain/api-rows.positive.json"], "pull_request").includes(id)));
});
