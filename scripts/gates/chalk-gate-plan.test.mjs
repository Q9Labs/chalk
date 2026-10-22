import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classify } from "@q9labsai/gates";
import gateConfig from "../../gate.config.ts";
import { ciJobs, createGatePlan, discoverWorkspaces, emptyScopeResult, GatePlanningError, gatePlanOptions, laneEnvironment, laneGroup, laneGroupLanes, laneResult, resolveGateTarget } from "./chalk-gate-plan.mjs";

function boundaryTask(files, options = {}) {
  return createGatePlan(files, options).tasks.find((task) => task.id === "boundaries");
}

test("application and SDK source changes select the package boundary check", () => {
  for (const file of ["apps/web/src/components/space/SpacePage.tsx", "sdks/typescript/client/src/sync/v1-client.ts"]) {
    assert.equal(boundaryTask([file])?.selected, true, file);
  }
});

test("Kotlin-only native module changes select the compatibility lint", () => {
  const file = "sdks/typescript/react-native/android/src/main/kotlin/ai/q9labs/chalk/reactnative/ChalkAudioRouteModule.kt";
  const semgrep = createGatePlan([file]).tasks.find((task) => task.id === "semgrep");
  assert.equal(semgrep?.selected, true);
  assert.deepEqual(semgrep?.command, ["bash", "scripts/gates/semgrep.sh", file]);
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

test("generated-file check is always selected and calls the named script", () => {
  const generated = createGatePlan(["docs/contract-codegen.md"]).tasks.find((task) => task.id === "generated");
  assert.equal(generated?.selected, true);
  assert.deepEqual(generated?.command, ["pnpm", "run", "check:generated"]);
});

test("external services leave API and Sync to their own CI jobs", () => {
  const services = (options) => createGatePlan(["apps/api/internal/server.go"], options).tasks.find((task) => task.id === "services");
  assert.equal(services({ services: "local" })?.selected, true);
  assert.equal(services({ services: "external" })?.selected, false);
});

test("the services lane has no command when no service gate is selected", () => {
  const services = (files, options) => createGatePlan(files, options).tasks.find((task) => task.id === "services");
  assert.equal(services(["apps/api/internal/server.go"], { services: "external" })?.command, null);
  assert.equal(services(["gate.config.ts"], { services: "external" })?.command, null);
  assert.equal(services(["docs/contract-codegen.md"], { services: "local" })?.command, null);
  assert.deepEqual(services(["apps/api/internal/server.go"], { services: "local" })?.command, ["bash", "scripts/gates/with-postgres.sh", "apps/api/scripts/gate.sh"]);
});

test("service gate selection follows the plan inputs", () => {
  const services = (files) => createGatePlan(files).services;
  assert.deepEqual(services(["docs/contract-codegen.md"]), { api: false, sync: false });
  assert.deepEqual(services(["apps/api/internal/server.go"]), { api: true, sync: false });
  assert.deepEqual(services(["apps/sync/lib/chalk_sync.ex"]), { api: false, sync: true });
  assert.deepEqual(services(["gate.config.ts"]), { api: true, sync: true });
});

test("gate target resolution prefers the environment and rejects a mismatch", () => {
  assert.equal(resolveGateTarget(undefined, "web"), "web");
  assert.equal(resolveGateTarget("web", undefined), "web");
  assert.equal(resolveGateTarget("web", "web"), "web");
  assert.equal(resolveGateTarget(undefined, undefined), undefined);
  assert.throws(() => resolveGateTarget("web", "mobile"), /must match/u);
});

test("plan options map each scope to its snapshot and base", () => {
  const classification = { fullRequired: false };
  const staged = gatePlanOptions({ allChangedFiles: [], scope: "staged", classification, target: undefined }, {});
  assert.deepEqual(staged, { full: false, scope: "staged", base: "origin/master", target: undefined, services: "local", snapshot: { mode: "index" }, workspaceConcurrency: 1 });
  const branch = gatePlanOptions({ allChangedFiles: [], scope: "branch", classification, target: "web", base: "origin/dev" }, { GATE_BASE_REF: "x" });
  assert.deepEqual(branch, { full: false, scope: "merge base to HEAD", base: "origin/dev", target: "web", services: "local", snapshot: { mode: "ref", ref: "HEAD" }, workspaceConcurrency: 1 });
  const full = gatePlanOptions({ allChangedFiles: [], scope: "full", classification, target: undefined }, { GATE_BASE_REF: "origin/main" });
  assert.deepEqual(full, { full: true, scope: "staged", base: "origin/main", target: undefined, services: "local", snapshot: { mode: "worktree" }, workspaceConcurrency: 1 });
  assert.equal(gatePlanOptions({ allChangedFiles: [], scope: "branch", classification, target: undefined }, { GATE_WORKSPACE_CONCURRENCY: "2" }).workspaceConcurrency, 2);
  assert.throws(
    () => gatePlanOptions({ allChangedFiles: [], scope: "branch", classification, target: undefined }, { GATE_WORKSPACE_CONCURRENCY: "0" }),
    (error) => error instanceof GatePlanningError && error.reason === "invalid-concurrency",
  );
  assert.equal(gatePlanOptions({ allChangedFiles: [], scope: "staged", classification: { fullRequired: true }, target: undefined }, {}).full, true);
  assert.equal(gatePlanOptions({ allChangedFiles: [], scope: "staged", classification: { fullRequired: false }, target: undefined }, { GATE_SERVICES: "external" }).services, "external");
});

test("a full plan scans committed secrets, because a clean checkout has nothing staged", () => {
  const secretScope = (options) => createGatePlan(["README.md"], options).tasks.find((task) => task.id === "secrets").env.GATE_SCOPE;
  assert.equal(secretScope({ full: true }), "full");
  assert.equal(secretScope({}), "staged");
  assert.equal(secretScope({ scope: "merge base to HEAD" }), "merge base to HEAD");
});

test("lane environment adds explicit files only for the secrets lane", () => {
  assert.deepEqual(laneEnvironment("secrets", { A: "1" }, ["a", "b"], true), [
    { name: "A", value: "1" },
    { name: "GATE_EXPLICIT_FILES", value: "a\nb" },
  ]);
  assert.deepEqual(laneEnvironment("secrets", { A: "1" }, ["a"], false), [{ name: "A", value: "1" }]);
  assert.deepEqual(laneEnvironment("types", {}, ["a"], true), []);
});

test("lane result reports output, falls back to a default message, and passes", () => {
  assert.deepEqual(laneResult("types", { failed: false }), { status: "passed" });
  assert.equal(laneResult("types", { failed: true, stdout: "out", stderr: "err" }).findings[0].message, "out\nerr");
  assert.deepEqual(laneResult("types", { failed: true, stdout: "", stderr: "" }).findings, [{ file: "gate.config.ts", rule: "types", message: "types failed" }]);
});

test("empty scope fails unless files exist, the scope is full, or empty is allowed", () => {
  assert.equal(emptyScopeResult({ allChangedFiles: ["a"], scope: "staged" }, {}).status, "passed");
  assert.equal(emptyScopeResult({ allChangedFiles: [], scope: "full" }, {}).status, "passed");
  assert.equal(emptyScopeResult({ allChangedFiles: [], scope: "staged" }, { GATE_ALLOW_EMPTY: "1" }).status, "passed");
  const branch = emptyScopeResult({ allChangedFiles: [], scope: "branch", base: "origin/master" }, {});
  assert.equal(branch.status, "failed");
  assert.match(branch.findings[0].message, /branch scope against origin\/master/u);
  assert.match(emptyScopeResult({ allChangedFiles: [], scope: "branch" }, {}).findings[0].message, /the base ref/u);
  assert.match(emptyScopeResult({ allChangedFiles: [], scope: "staged" }, {}).findings[0].message, /staged scope/u);
});

test("scoped builds include workspace dependencies without widening other lanes", () => {
  const workspaces = [
    { name: "web", directory: "apps/web", scripts: { build: "vite build", test: "vitest", "check-types": "tsc" }, dependencies: ["@chalk/shared"] },
    { name: "@chalk/shared", directory: "packages/shared", scripts: { build: "tsc" }, dependencies: [] },
    { name: "unrelated", directory: "apps/unrelated", scripts: { build: "tsc" }, dependencies: [] },
  ];
  const plan = createGatePlan(["apps/web/src/main.ts"], { workspaces });
  const command = (id) => plan.tasks.find((task) => task.id === id).command;
  assert.deepEqual(command("build"), ["pnpm", "exec", "turbo", "run", "build", "--force", "--filter=web..."]);
  assert.deepEqual(command("types"), ["pnpm", "--workspace-concurrency=1", "--sort", "--filter", "web", "run", "check-types"]);
  assert.equal(plan.tasks.find((task) => task.id === "tests").selected, false);
  assert.equal(command("tests"), null);
  assert.deepEqual(command("browser-tests"), ["pnpm", "--filter", "web", "run", "test"]);
  assert.deepEqual(
    createGatePlan(["apps/web/src/main.ts"], { workspaces, workspaceConcurrency: 2 })
      .tasks.find((task) => task.id === "types")
      .command.slice(0, 2),
    ["pnpm", "--workspace-concurrency=2"],
  );
  const docs = createGatePlan(["docs/guide.md"], { workspaces });
  assert.equal(docs.tasks.find((task) => task.id === "build").command, null);
  assert.deepEqual(docs.services, { api: false, sync: false });
});

test("separate call timing and leak budgets follow call renderers and full gates", () => {
  for (const file of ["apps/web/src/components/space/SpacePage.tsx", "sdks/typescript/react/src/index.ts", "packages/ui/src/button.tsx", "packages/whiteboard/src/index.ts", "pnpm-lock.yaml"]) {
    const lane = createGatePlan([file]).tasks.find((task) => task.id === "call-performance");
    assert.equal(lane.selected, true, file);
    assert.deepEqual(lane.command, ["node", "apps/web/scripts/check-call-performance.mjs", "--gate", "--timing-only"]);
    const leaks = createGatePlan([file]).tasks.find((task) => task.id === "call-leaks");
    assert.equal(leaks.selected, true, file);
    assert.deepEqual(leaks.command, ["node", "apps/web/scripts/check-call-performance.mjs", "--gate", "--leaks-only", "--out", "artifacts/call-leaks.json"]);
  }
  assert.equal(createGatePlan(["docs/performance-budget.md"]).tasks.find((task) => task.id === "call-performance").selected, false);
  assert.equal(createGatePlan(["docs/performance-budget.md"]).tasks.find((task) => task.id === "call-leaks").selected, false);
  assert.equal(createGatePlan([], { full: true }).tasks.find((task) => task.id === "call-leaks").selected, true);
});

// CI skips a root job when Chalk's plan selects none of its lanes, so q9gate must never run a full gate that Chalk's
// plan does not.
test("every path that makes q9gate run in full also makes Chalk's plan run in full", () => {
  const workspaces = discoverWorkspaces();
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const nested = ["apps/web/turbo.json", "packages/ui/lefthook.yml", "apps/sync/scripts/gates/run.sh", "tools/x/.github/workflows/ci.yml", "apps/web/public/logo.svg", "osv-scanner.toml", ".tool-versions"];
  for (const file of [...tracked, ...nested]) {
    if (classify([file], gateConfig.classifiers).fullRequired) assert.equal(createGatePlan([file], { workspaces }).full, true, file);
  }
});

test("CI runs only the jobs whose lanes the plan selects", () => {
  assert.deepEqual(ciJobs(["docs/contract-codegen.md"]), { api: false, sync: false, rootGroups: ["checks"] });
  assert.deepEqual(ciJobs(["apps/api/internal/server.go"]), { api: true, sync: false, rootGroups: ["checks"] });
  assert.deepEqual(ciJobs(["apps/web/src/main.tsx"]), { api: false, sync: false, rootGroups: ["checks", "browser-tests", "call-performance", "call-leaks", "build"] });
  assert.deepEqual(ciJobs(["sdks/typescript/react/src/index.ts"]), { api: false, sync: false, rootGroups: ["checks", "tests", "browser-tests", "call-performance", "call-leaks", "build"] });
  assert.deepEqual(ciJobs(["gate.config.ts"]), { api: true, sync: true, rootGroups: ["checks", "tests", "browser-tests", "call-performance", "call-leaks", "build"] });
  assert.deepEqual(ciJobs([], { full: true }), { api: true, sync: true, rootGroups: ["checks", "tests", "browser-tests", "call-performance", "call-leaks", "build"] });
});

test("deployment tree changes run the gates that read them, not a full gate", () => {
  for (const file of ["infrastructure/managed-episode/env/api.nightly.env.example", "infrastructure/nightly/transcription/main.tf"]) {
    const plan = createGatePlan([file]);
    assert.equal(plan.full, false, file);
    assert.equal(plan.tasks.find((task) => task.id === "recorder")?.selected, true, file);
    assert.deepEqual(ciJobs([file]), { api: true, sync: true, rootGroups: ["checks"] }, file);
  }
  assert.equal(createGatePlan(["infrastructure/observability/new.yaml"]).full, true);
});

function ciJobsOutput(base) {
  const stdout = execFileSync("node", [fileURLToPath(new URL("chalk-gate-plan.mjs", import.meta.url)), "--ci-jobs", base], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

const fullCiJobs = { api: "true", sync: "true", root_groups: JSON.stringify(ciJobs([], { full: true }).rootGroups), full: "true" };

test("CI job selection that cannot resolve its base runs every job in full", () => {
  assert.deepEqual(ciJobsOutput("origin/chalk-gate-plan-missing-base"), fullCiJobs);
  assert.deepEqual(ciJobsOutput("--full"), fullCiJobs);
  assert.equal(ciJobsOutput("HEAD").full, "false");
});

// When Select gate jobs fails, the workflow falls back to its own list of root groups.
test("the Gate workflow falls back to every root lane group", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");
  const fallback = /needs\.changes\.outputs\.root_groups \|\| '([^']+)'/u.exec(workflow)?.[1];
  assert.deepEqual(JSON.parse(fallback ?? "null"), ciJobs([], { full: true }).rootGroups);
});

test("browser CI groups each run only their own selected lane", () => {
  const plan = createGatePlan(["apps/web/src/components/space/SpacePage.tsx"]);
  for (const group of ["browser-tests", "call-performance", "call-leaks"]) {
    assert.deepEqual(
      laneGroupLanes(plan.tasks, group)
        .filter((lane) => lane.selected)
        .map((lane) => lane.id),
      [group],
    );
  }
  assert.deepEqual(ciJobs(["apps/web/src/components/space/SpacePage.tsx"]).rootGroups, ["checks", "browser-tests", "call-performance", "call-leaks", "build"]);
});

test("every lane runs in exactly one CI lane group", () => {
  const lanes = gateConfig.lanes;
  const groups = ["checks", "tests", "browser-tests", "call-performance", "call-leaks", "build"].map((group) => laneGroupLanes(lanes, group).map((lane) => lane.id));
  assert.deepEqual(groups.flat().toSorted(), lanes.map((lane) => lane.id).toSorted());
  assert.equal(laneGroup("publint"), "build");
  assert.equal(laneGroup("browser-tests"), "browser-tests");
  assert.equal(laneGroup("call-performance"), "call-performance");
  assert.equal(laneGroup("call-leaks"), "call-leaks");
  assert.equal(laneGroup("a-new-lane"), "checks");
  assert.equal(laneGroupLanes(lanes, undefined), lanes);
  assert.throws(
    () => laneGroupLanes(lanes, "nope"),
    (error) => error instanceof GatePlanningError && error.reason === "invalid-lane-group",
  );
});

test("CI installs the same scanner versions that the gate scripts fall back to", () => {
  const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const action = read(".github/actions/setup-scanners/action.yml");
  assert.match(read("scripts/gates/gitleaks.sh"), new RegExp(`gitleaks/v8@v${/gitleaks_version="([^"]+)"/u.exec(action)[1]}\\b`, "u"));
  assert.match(read("scripts/gates/osv-scanner.sh"), new RegExp(`osv-scanner@v${/osv_version="([^"]+)"/u.exec(action)[1]}\\b`, "u"));
});

test("gitleaks loads its default rules, because a config without them has no rules at all", () => {
  assert.match(readFileSync(new URL("../../.gitleaks.toml", import.meta.url), "utf8"), /^\[extend\]\nuseDefault = true$/mu);
});
