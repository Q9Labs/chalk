import assert from "node:assert/strict";
import test from "node:test";
import { ciJobs, createGatePlan, laneGroup } from "./chalk-gate-plan.mjs";
const jobs = (files, event) => ciJobs(files, { event });
const selected = (files, event) =>
  createGatePlan(files, { scope: "merge base to HEAD", services: "external", event })
    .tasks.filter((task) => task.selected)
    .map((task) => task.id);

test("a change to the release scripts, the managed-host controller or the scorecard runs the release contracts in the checks group", () => {
  for (const file of [
    "scripts/releases/test_release.py",
    "scripts/releases/release.py",
    "infrastructure/managed-episode/controller/chalk-deployment-controller",
    "features/scorecard/evaluate.mjs",
    "perf/budgets.json",
    ".github/workflows/ci.yml",
    ".github/workflows/nightly.yml",
    "scripts/recorder/release.py",
    "infrastructure/transcription-dispatcher/alchemy.run.ts",
    "infrastructure/releases/driver.ts",
    "scripts/recorder/alchemy_dispatcher.py",
    "apps/api/go.mod",
    "apps/api/db/migrations/20261101000000_example.sql",
    "apps/api/internal/httpapi/router.go",
    "apps/api/cmd/recorder-render/main.go",
  ]) {
    assert.ok(selected([file], "pull_request").includes("release-contracts"), file);
    assert.ok(selected([file], "merge_group").includes("release-contracts"), file);
  }
  assert.ok(createGatePlan([], { full: true, scope: "merge base to HEAD", services: "external" }).tasks.find((task) => task.id === "release-contracts").selected);
  assert.ok(!selected(["docs/observability.md"], "pull_request").includes("release-contracts"));
  assert.ok(!selected(["apps/web/src/App.tsx"], "pull_request").includes("release-contracts"));
  assert.ok(!selected(["scripts/recorder/compare-frames.mjs"], "pull_request").includes("release-contracts"));
  assert.ok(!selected(["apps/api/internal/httpapi/router_test.go"], "pull_request").includes("release-contracts"));
  assert.equal(laneGroup("release-contracts"), "checks");
});
