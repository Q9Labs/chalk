import assert from "node:assert/strict";
import test from "node:test";
import { ciJobs, createGatePlan, gatePlanOptions } from "./chalk-gate-plan.mjs";

const jobs = (files, event) => ciJobs(files, { event });
const selected = (files, event) =>
  createGatePlan(files, { scope: "merge base to HEAD", services: "external", event })
    .tasks.filter((task) => task.selected)
    .map((task) => task.id);

test("documentation selects only the always-on lane group on every event", () => {
  for (const event of ["pull_request", undefined]) {
    assert.deepEqual(jobs(["docs/observability.md"], event), { api: false, sync: false, rootGroups: ["checks"] });
    assert.ok(selected(["docs/observability.md"], event).includes("feature-map"));
  }
});

test("a pull request that edits a release or proof workflow runs the graph tests, not the full gate", () => {
  const files = [".github/workflows/nightly.yml"];
  const pullRequest = createGatePlan(files, { scope: "merge base to HEAD", services: "external", event: "pull_request" });
  assert.equal(pullRequest.full, false);
  assert.deepEqual(jobs(files, "pull_request").rootGroups, ["checks"]);
  assert.ok(selected(files, "pull_request").includes("workflow-graph"));
});

test("the merge queue and local runs keep the full gate for any workflow edit", () => {
  for (const event of ["merge_group", undefined]) {
    assert.equal(createGatePlan([".github/workflows/nightly.yml"], { scope: "merge base to HEAD", services: "external", event }).full, true);
  }
});

test("the Gate workflow, its cache warm-up and its scripts still select the full gate on a pull request", () => {
  for (const file of [".github/workflows/gate.yml", ".github/workflows/cache-warm.yml", "scripts/gates/osv-scanner.sh"]) {
    assert.equal(createGatePlan([file], { scope: "merge base to HEAD", services: "external", event: "pull_request" }).full, true, file);
  }
});

test("the Gate's own README is documentation and selects no gate definition on a pull request", () => {
  assert.equal(createGatePlan(["scripts/gates/README.md"], { scope: "merge base to HEAD", services: "external", event: "pull_request" }).full, false);
});

test("a path no lane reads is classified on a pull request and fails closed elsewhere", () => {
  const file = "infrastructure/observability/production-alerts/collector.go";
  assert.equal(createGatePlan([file], { scope: "merge base to HEAD", services: "external", event: "pull_request" }).full, false);
  assert.equal(createGatePlan([file], { scope: "merge base to HEAD", services: "external", event: "merge_group" }).full, true);
});

test("a test-only change skips the dashboard engine and the call lanes on a pull request, and the queue still runs them", () => {
  const files = ["sdks/typescript/client/src/media/client.test.ts"];
  assert.deepEqual(
    jobs(files, "pull_request").rootGroups.filter((group) => group.startsWith("dashboard-") || group.startsWith("call-leaks-")),
    [],
  );
  assert.deepEqual(
    jobs(files, "merge_group").rootGroups.filter((group) => group.startsWith("dashboard-") || group.startsWith("call-leaks-")),
    ["dashboard-engine", "dashboard-refresh", "call-leaks-1", "call-leaks-2", "call-leaks-3"],
  );
});

test("a shipped call input selects the dashboard engine and the leak shards on a pull request", () => {
  const groups = jobs(["sdks/typescript/client/src/media/client.ts"], "pull_request").rootGroups;
  for (const group of ["dashboard-engine", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"]) assert.ok(groups.includes(group), group);
});

test("an API change runs the API gate and the dashboard engine, and no call lane", () => {
  const result = jobs(["apps/api/internal/httpapi/router.go"], "pull_request");
  assert.equal(result.api, true);
  assert.ok(result.rootGroups.includes("dashboard-engine"));
  assert.ok(!result.rootGroups.some((group) => group.startsWith("call-leaks-")));
});

test("an API test-only change still runs the API gate", () => {
  const result = jobs(["apps/api/internal/httpapi/router_test.go"], "pull_request");
  assert.equal(result.api, true);
  assert.ok(!result.rootGroups.includes("dashboard-engine"));
});

test("the merge queue selects the dashboard engine and every leak shard for any change beyond documentation", () => {
  assert.deepEqual(jobs(["scripts/dev/doctor.sh"], "merge_group").rootGroups, ["checks", "dashboard-engine", "dashboard-refresh", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"]);
  assert.deepEqual(jobs(["docs/observability.md"], "merge_group").rootGroups, ["checks"]);
});

test("the refresh proof is its own lane: a pull request runs it for refresh inputs, the queue for every change", () => {
  const refresh = (files, event) => jobs(files, event).rootGroups.includes("dashboard-refresh");
  assert.equal(refresh(["apps/api/internal/httpapi/router.go"], "pull_request"), false);
  assert.equal(refresh(["apps/web/src/components/space/Controls.tsx"], "pull_request"), false);
  assert.equal(refresh(["apps/api/internal/accessgrants/types.go"], "pull_request"), true);
  assert.equal(refresh(["apps/web/server/owner-access.ts"], "pull_request"), true);
  assert.equal(refresh(["apps/web/tests/dashboard/owner-refresh.mjs"], "pull_request"), true);
  assert.equal(refresh(["apps/api/internal/httpapi/router.go"], "merge_group"), true);
  assert.equal(refresh(["docs/observability.md"], "merge_group"), false);
  assert.ok(ciJobs([], { full: true }).rootGroups.includes("dashboard-refresh"));
});

test("the workflow graph tests run for scorecard edits and the full gate", () => {
  assert.ok(selected(["features/scorecard/budgets.mjs"], "pull_request").includes("workflow-graph"));
  assert.ok(createGatePlan([], { full: true, scope: "merge base to HEAD", services: "external" }).tasks.find((task) => task.id === "workflow-graph").selected);
  assert.ok(!selected(["docs/observability.md"], "pull_request").includes("workflow-graph"));
});

test("the register check runs when a check input changes, and the formal Sync check runs when its model inputs change", () => {
  assert.ok(selected([".github/workflows/nightly.yml"], "pull_request").includes("register"));
  assert.ok(selected(["perf/budgets.json"], "pull_request").includes("register"));
  assert.ok(!selected(["docs/observability.md"], "pull_request").includes("register"));
  assert.ok(selected(["tools/formal/sync-entry-leave/run.sh"], "pull_request").includes("formal-sync"));
  assert.ok(!selected(["docs/observability.md"], "pull_request").includes("formal-sync"));
  assert.ok(createGatePlan([], { full: true, scope: "merge base to HEAD", services: "external" }).tasks.find((task) => task.id === "formal-sync").selected);
});

test("q9gate's own gate-behavior classification does not widen a pull request that the planner narrows", () => {
  const context = { scope: "branch", classification: { fullRequired: true } };
  assert.equal(gatePlanOptions(context, { GATE_EVENT: "pull_request" }).full, false);
  assert.equal(gatePlanOptions({ ...context, scope: "full" }, { GATE_EVENT: "pull_request" }).full, true);
});
