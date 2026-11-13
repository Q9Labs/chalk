import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ciJobs, createGatePlan, gatePlanOptions, laneGroup, shareProvenGroups, workflowGraphNodeTests, workflowGraphPythonTest, workflowGraphRoots } from "./chalk-gate-plan.mjs";

const jobs = (files, event) => ciJobs(files, { event });
const selected = (files, event) =>
  createGatePlan(files, { scope: "merge base to HEAD", services: "external", event })
    .tasks.filter((task) => task.selected)
    .map((task) => task.id);

test("documentation selects only the always-on lane group on every event", () => {
  for (const event of ["pull_request", undefined]) {
    assert.deepEqual(jobs(["docs/observability.md"], event), { api: false, sync: false, rootGroups: ["checks"], planFull: false });
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

test("the feature map is read only by the always-on feature-map lane, so editing it selects no more than that on every event", () => {
  for (const event of ["pull_request", "merge_group"]) {
    const plan = createGatePlan(["features.json"], { scope: "merge base to HEAD", services: "external", event });
    assert.equal(plan.full, false);
    assert.ok(
      plan.tasks
        .filter((task) => task.selected)
        .map((task) => task.id)
        .includes("feature-map"),
    );
  }
});

test("a host-change-alert edit is classified on a pull request and fails closed elsewhere", () => {
  const file = "infrastructure/host-change-alert/host-change-check.mjs";
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

test("a change to the release scripts, the managed-host controller or the scorecard runs the release contracts in the checks group", () => {
  for (const file of [
    "scripts/releases/test_release.py",
    "scripts/releases/release.py",
    "infrastructure/managed-episode/controller/chalk-deployment-controller",
    "features/scorecard/evaluate.mjs",
    "perf/budgets.json",
    "scripts/recorder/release.py",
    "infrastructure/nightly/transcription/main.tf",
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

test("a pull request that edits only a workflow skips the SFU lane and still runs the whole staging-lease test file", () => {
  const files = [".github/workflows/ci.yml"];
  const plan = createGatePlan(files, { scope: "merge base to HEAD", services: "external", event: "pull_request" });
  assert.ok(!plan.tasks.find((task) => task.id === "sfu").selected);
  const graph = plan.tasks.find((task) => task.id === "workflow-graph");
  assert.ok(graph.selected);
  assert.match(graph.command.join(" "), /python3 scripts\/staging-sfu\/test_staging_lock\.py$/);
});

test("a test of the workflow-graph lane reads only paths that lane selects", () => {
  const repositoryPath = /(?:\.github|scripts|features|apps|sdks|packages|infrastructure|docs)\/[\w./-]*\w/gu;
  for (const file of [...workflowGraphNodeTests, workflowGraphPythonTest]) {
    const outside = [...new Set(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").match(repositoryPath))].filter((path) => !workflowGraphRoots.some((root) => path.startsWith(root)));
    assert.deepEqual(outside, [], `${file} reads paths that do not select the workflow-graph lane`);
  }
  for (const file of [".github/actions/setup-playwright/action.yml", "scripts/staging-sfu/staging-lock", "scripts/staging-sfu/gate-lease", "scripts/prod-proof/cleanup.mjs", "scripts/deploy/deploy-managed-release.mjs"]) {
    assert.ok(selected([file], "pull_request").includes("workflow-graph"), file);
  }
});

const queueJobs = { api: true, sync: false, rootGroups: ["checks", "dashboard-engine", "dashboard-refresh", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"], full: false };
const proof = { api: true, sync: false, rootGroups: ["checks", "dashboard-engine", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"] };
const noDrift = { api: false, sync: false, rootGroups: ["checks"], planFull: false, entries: 1 };

test("a queue group skips what its pull request proved and master did not touch since", () => {
  const shared = shareProvenGroups(queueJobs, proof, noDrift);
  assert.deepEqual(shared.rootGroups, ["checks", "dashboard-refresh"]);
  assert.equal(shared.api, false);
  assert.deepEqual(shared.shared.sort(), ["api", "build", "call-leaks-1", "call-leaks-2", "call-leaks-3", "dashboard-engine"]);
});

test("a group whose inputs master changed since the pull request run runs again", () => {
  const drift = { ...noDrift, api: true, rootGroups: ["checks", "dashboard-engine"] };
  const shared = shareProvenGroups(queueJobs, proof, drift);
  assert.ok(shared.rootGroups.includes("dashboard-engine"));
  assert.equal(shared.api, true);
  assert.ok(!shared.rootGroups.includes("build"));
});

test("the leak shards are skipped together or not at all", () => {
  const partial = { ...proof, rootGroups: ["checks", "call-leaks-1", "call-leaks-2"] };
  assert.ok(shareProvenGroups(queueJobs, partial, noDrift).rootGroups.filter((group) => group.startsWith("call-leaks-")).length === 3);
  const drifted = { ...noDrift, rootGroups: ["checks", "call-leaks-2"] };
  assert.ok(shareProvenGroups(queueJobs, proof, drifted).rootGroups.filter((group) => group.startsWith("call-leaks-")).length === 3);
});

test("nothing is shared when master changed the Gate itself, or the plan failed", () => {
  assert.deepEqual(shareProvenGroups(queueJobs, proof, { ...noDrift, planFull: true }).rootGroups, queueJobs.rootGroups);
  assert.deepEqual(shareProvenGroups({ ...queueJobs, full: true }, proof, noDrift).rootGroups, queueJobs.rootGroups);
  assert.deepEqual(shareProvenGroups({ ...queueJobs, planFull: true }, proof, noDrift).rootGroups, queueJobs.rootGroups);
});

test("a group that holds more than one pull request shares nothing", () => {
  assert.deepEqual(shareProvenGroups(queueJobs, proof, { ...noDrift, entries: 2 }).rootGroups, queueJobs.rootGroups);
  assert.equal(shareProvenGroups(queueJobs, proof, { ...noDrift, entries: 2 }).api, true);
});

test("the checks group always runs", () => {
  assert.ok(shareProvenGroups(queueJobs, proof, noDrift).rootGroups.includes("checks"));
});

test("the register check runs when a check input changes, and the formal Sync check runs when its model inputs change", () => {
  assert.ok(selected([".github/workflows/nightly.yml"], "pull_request").includes("register"));
  assert.ok(selected(["perf/budgets.json"], "pull_request").includes("register"));
  assert.ok(!selected(["docs/observability.md"], "pull_request").includes("register"));
  assert.ok(selected(["tools/formal/sync-entry-leave/run.sh"], "pull_request").includes("formal-sync"));
  assert.ok(!selected(["docs/observability.md"], "pull_request").includes("formal-sync"));
  assert.ok(createGatePlan([], { full: true, scope: "merge base to HEAD", services: "external" }).tasks.find((task) => task.id === "formal-sync").selected);
});

test("the SFU lane runs in its own group, so an SFU change does not lengthen the checks group", () => {
  assert.ok(jobs(["features/media/sfu/server/main.go"], "pull_request").rootGroups.includes("sfu"));
  assert.ok(!jobs(["apps/web/src/main.tsx"], "pull_request").rootGroups.includes("sfu"));
  assert.equal(laneGroup("sfu"), "sfu");
});

test("q9gate's own gate-behavior classification does not widen a pull request that the planner narrows", () => {
  const context = { scope: "branch", classification: { fullRequired: true } };
  assert.equal(gatePlanOptions(context, { GATE_EVENT: "pull_request" }).full, false);
  assert.equal(gatePlanOptions({ ...context, scope: "full" }, { GATE_EVENT: "pull_request" }).full, true);
});

test("the mock-call ratchet runs for every kind of test file it counts, not only TypeScript", () => {
  const files = [
    "sdks/typescript/client/src/media/client.test.js",
    "sdks/typescript/client/src/media/client.spec.mjs",
    "sdks/typescript/client/src/media/client.test.cjs",
    "sdks/typescript/react/src/components/Panel.test.jsx",
    "sdks/typescript/client/src/media/client.test.mts",
    "sdks/typescript/client/src/__tests__/client.js",
  ];
  for (const file of files) {
    const plan = createGatePlan([file], { scope: "merge base to HEAD", services: "external", event: "pull_request" });
    assert.equal(plan.full, false, file);
    assert.ok(selected([file], "pull_request").includes("mock-calls"), file);
  }
  assert.ok(selected(["scripts/gates/mock-call-baseline.json"], "pull_request").includes("mock-calls"));
  assert.ok(!selected(["docs/observability.md"], "pull_request").includes("mock-calls"));
});
