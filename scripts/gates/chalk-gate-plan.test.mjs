import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LEAK_JOURNEYS, leakShard, checkLeakShardReports } from "../../apps/web/scripts/call-leak-check.mjs";
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

test("Kotlin-only native module changes do not select JavaScript/TypeScript structural rules", () => {
  const file = "sdks/typescript/react-native/android/src/main/kotlin/ai/q9labs/chalk/reactnative/ChalkAudioRouteModule.kt";
  assert.equal(createGatePlan([file]).tasks.find((task) => task.id === "ast-grep")?.selected, false);
});

test("structural rules include changed manifests and type bans follow TypeScript inputs", () => {
  for (const file of ["apps/web/src/lib/chunkReload.ts", "packages/ui/package.json", "apps/api/sqlc.yaml"]) {
    const task = createGatePlan([file]).tasks.find((entry) => entry.id === "ast-grep");
    assert.equal(task?.selected, true, file);
    assert.deepEqual(task?.command, ["node", "scripts/gates/ast-grep.mjs", file]);
  }
  assert.equal(createGatePlan(["apps/web/src/lib/chunkReload.ts"]).tasks.find((task) => task.id === "explicit-any")?.selected, true);
  assert.equal(createGatePlan(["docs/contract-codegen.md"]).tasks.find((task) => task.id === "explicit-any")?.selected, false);
  assert.equal(laneGroup("explicit-any"), "checks");
});

test("documentation-only changes do not select the package boundary check", () => {
  assert.equal(boundaryTask(["docs/contract-codegen.md"])?.selected, false);
});

test("design-token and worklet checks follow their SDK inputs into the CI checks group", () => {
  const selected = (file, id) => createGatePlan([file]).tasks.find((task) => task.id === id)?.selected;
  assert.equal(selected("sdks/typescript/react/src/components/CallReady.tsx", "react-tokens"), true);
  assert.equal(selected("packages/ui/src/styles/index.css", "react-tokens"), true);
  assert.equal(selected("sdks/typescript/react-native/src/theme/tokens.ts", "native-quality"), true);
  assert.equal(selected("sdks/typescript/react-native/src/theme/tokens.ts", "react-tokens"), false);
  assert.equal(selected("docs/contract-codegen.md", "react-tokens"), false);
  assert.equal(selected("docs/contract-codegen.md", "native-quality"), false);
  assert.equal(selected("pnpm-lock.yaml", "react-tokens"), true);
  assert.equal(selected("pnpm-lock.yaml", "native-quality"), true);
  assert.equal(laneGroup("react-tokens"), "checks");
  assert.equal(laneGroup("native-quality"), "checks");
});

test("token scanner, exception, baseline and CI changes retain executable token lanes in CI", () => {
  const reactInputs = ["sdks/typescript/react/scripts/check-token-reach.mjs", "sdks/typescript/react/scripts/token-exceptions.json", "sdks/typescript/react/scripts/token-reach-baseline.json", "sdks/typescript/react/src/theme.ts", "packages/ui/src/styles/index.css"];
  const nativeInputs = ["sdks/typescript/react-native/scripts/check-tokenized-styles.mjs", "sdks/typescript/react-native/src/theme/tokens.ts"];
  const sharedInputs = ["scripts/gates/color-source.mjs", "scripts/gates/design-tokens.test.mjs", ".github/workflows/gate.yml", "gate.config.ts"];
  for (const file of [...reactInputs, ...nativeInputs, ...sharedInputs]) {
    const plan = createGatePlan([file]);
    const checks = laneGroupLanes(plan.tasks, "checks").filter(({ selected }) => selected);
    assert.ok(ciJobs([file]).rootGroups.includes("checks"), file);
    const ids = sharedInputs.includes(file) ? ["react-tokens", "native-quality"] : reactInputs.includes(file) ? ["react-tokens"] : ["native-quality"];
    for (const id of ids) {
      const lane = checks.find((task) => task.id === id);
      assert.ok(lane?.command.some((part) => /check-token|check:tokens/u.test(part)), `${file}: ${id} must execute a scanner`);
    }
  }
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

test("the real dashboard engine proof cannot be skipped with external service gates", () => {
  for (const file of ["apps/web/server/owner-access.ts", "apps/api/internal/httpapi/access_grants.go", "sdks/typescript/client/src/connection/lifecycle.ts"]) {
    const plan = createGatePlan([file], { services: "external" });
    const lane = plan.tasks.find((task) => task.id === "dashboard-engine");
    assert.equal(lane?.selected, true, file);
    assert.deepEqual(lane?.command, ["bash", "apps/web/tests/dashboard/check-engine.sh"]);
    assert(laneGroupLanes(plan.tasks, "browser-tests").includes(lane));
    assert(ciJobs([file]).rootGroups.includes("browser-tests"));
  }
  assert.equal(createGatePlan(["docs/contract-codegen.md"]).tasks.find((task) => task.id === "dashboard-engine")?.selected, false);
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
  assert.deepEqual(services(["apps/api/db/migrations/20261028120000_example.sql"]), { api: true, sync: true });
  assert.deepEqual(services(["sdks/typescript/client/src/generated/sync.ts"]), { api: false, sync: true });
  assert.deepEqual(services(["sdks/typescript/client/scripts/real-browser-sync.mjs"]), { api: false, sync: true });
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
  assert.deepEqual(ciJobs(["apps/api/internal/server.go"]), { api: true, sync: false, rootGroups: ["checks", "browser-tests"] });
  assert.deepEqual(ciJobs(["apps/web/src/main.tsx"]), { api: false, sync: false, rootGroups: ["checks", "browser-tests", "call-performance", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"] });
  assert.deepEqual(ciJobs(["sdks/typescript/react/src/index.ts"]), { api: false, sync: false, rootGroups: ["checks", "tests", "browser-tests", "call-performance", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"] });
  assert.deepEqual(ciJobs(["gate.config.ts"]), { api: true, sync: true, rootGroups: ["checks", "tests", "browser-tests", "call-performance", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"] });
  assert.deepEqual(ciJobs([], { full: true }), { api: true, sync: true, rootGroups: ["checks", "tests", "browser-tests", "call-performance", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"] });
});

test("deployment tree changes run the gates that read them, not a full gate", () => {
  for (const file of ["infrastructure/managed-episode/env/api.nightly.env.example", "infrastructure/nightly/transcription/main.tf"]) {
    const plan = createGatePlan([file]);
    assert.equal(plan.full, false, file);
    assert.equal(plan.tasks.find((task) => task.id === "recorder")?.selected, true, file);
    assert.deepEqual(ciJobs([file]), { api: true, sync: true, rootGroups: ["checks", "browser-tests"] }, file);
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

// The runner still exports what a failed Select gate jobs wrote, such as root_groups=["checks"] and full=false
// followed by a crash, so every place that narrows on those outputs must also see that the selection succeeded.
test("the Gate workflow narrows only on a job selection that succeeded", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");
  const narrowing = workflow.split("\n").filter((line) => /needs\.changes\.outputs\.(root_groups|full)\b/u.test(line));
  assert.equal(narrowing.length, 8);
  for (const line of narrowing) assert.match(line, /needs\.changes\.result [!=]= 'success'|"\$\{\{ needs\.changes\.result \}\}" == "success"/u, line.trim());
});

test("browser CI groups each run only their own selected lanes", () => {
  const plan = createGatePlan(["apps/web/src/components/space/SpacePage.tsx"]);
  for (const group of ["browser-tests", "call-performance", "call-leaks-1", "call-leaks-2", "call-leaks-3"]) {
    assert.deepEqual(
      laneGroupLanes(plan.tasks, group)
        .filter((lane) => lane.selected)
        .map((lane) => lane.id),
      group === "browser-tests" ? ["browser-tests", "dashboard-engine"] : [group.startsWith("call-leaks-") ? "call-leaks" : group],
    );
  }
  assert.deepEqual(ciJobs(["apps/web/src/components/space/SpacePage.tsx"]).rootGroups, ["checks", "browser-tests", "call-performance", "call-leaks-1", "call-leaks-2", "call-leaks-3", "build"]);
});

test("every lane runs in exactly one CI lane group", () => {
  const lanes = gateConfig.lanes;
  const groups = ["checks", "tests", "browser-tests", "call-performance", "call-leaks-1", "build"].map((group) => laneGroupLanes(lanes, group).map((lane) => lane.id));
  assert.deepEqual(groups.flat().toSorted(), lanes.map((lane) => lane.id).toSorted());
  assert.equal(laneGroup("publint"), "build");
  assert.equal(laneGroup("browser-tests"), "browser-tests");
  assert.equal(laneGroup("call-performance"), "call-performance");
  assert.equal(laneGroup("call-leaks"), "call-leaks-1");
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

test("leak shards cover all journeys exactly once, including uneven splits", () => {
  for (const total of [3, 4]) {
    const shards = Array.from({ length: total }, (_, offset) => leakShard(`${offset + 1}/${total}`));
    assert.deepEqual(shards.flatMap(({ journeys }) => journeys).toSorted(), LEAK_JOURNEYS.toSorted());
    assert.equal(shards.filter(({ selfTest }) => selfTest).length, 1);
  }
  for (const value of ["0/3", "4/3", "1/10", "1/0", "1.5/3", "1/3junk"]) assert.throws(() => leakShard(value));
});

test("leak shard reports fail closed on missing shards, journeys and self-tests", () => {
  const reports = Array.from({ length: 3 }, (_, offset) => {
    const { index, total, journeys, selfTest } = leakShard(`${offset + 1}/3`);
    return {
      leakShard: { index, total },
      leakRepeats: 1,
      errors: [],
      failures: [],
      leaks: {
        results: [...journeys.map((journey) => ({ journey, repeat: 0 })), ...(selfTest ? [{ journey: "panels", repeat: 1 }] : [])],
        failures: [],
        selfTest: (selfTest ? ["resource-lifecycle", "listener", "detached", "none"] : []).map((injection) => ({ injection, detected: true })),
      },
    };
  });
  assert.doesNotThrow(() => checkLeakShardReports(reports));
  assert.throws(() => checkLeakShardReports(reports.slice(0, 2)), /Expected 3 leak shard reports, got 2/u);
  const missingJourney = structuredClone(reports);
  missingJourney[1].leaks.results.pop();
  assert.throws(() => checkLeakShardReports(missingJourney), /journey coverage mismatch/u);
  assert.throws(() => checkLeakShardReports([reports[0], reports[0], reports[2]]), /duplicate leak shard/u);
  const extraSelfTest = structuredClone(reports);
  extraSelfTest[1].leaks.selfTest = reports[0].leaks.selfTest;
  assert.throws(() => checkLeakShardReports(extraSelfTest), /self-test mismatch/u);
});

test("each leak CI group selects the shared lane with its own shard and report", () => {
  const previous = process.env.GATE_LANE_GROUP;
  try {
    for (let index = 1; index <= 3; index++) {
      const group = `call-leaks-${index}`;
      process.env.GATE_LANE_GROUP = group;
      const task = createGatePlan([], { full: true }).tasks.find(({ id }) => id === "call-leaks");
      assert.deepEqual(task.command, ["node", "apps/web/scripts/check-call-performance.mjs", "--gate", "--leaks-only", "--out", `artifacts/${group}.json`, "--shard", `${index}/3`]);
      const lanes = execFileSync("node", ["--input-type=module", "-e", 'import config from "./gate.config.ts"; console.log(JSON.stringify(config.lanes.map(({ id }) => id)))'], { encoding: "utf8", env: { ...process.env, GATE_LANE_GROUP: group } });
      assert.deepEqual(JSON.parse(lanes), ["call-leaks"]);
    }
  } finally {
    if (previous === undefined) delete process.env.GATE_LANE_GROUP;
    else process.env.GATE_LANE_GROUP = previous;
  }
});

test("leak coverage validates any planned shard and rejects partial plans", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");
  const guard = "needs.changes.result != 'success' || contains(needs.changes.outputs.root_groups || '', 'call-leaks-')";
  for (const step of ["Download leak shard reports", "Require complete leak journey coverage"]) {
    assert.equal(workflow.split(`- name: ${step}\n`)[1]?.split("\n")[0].trim(), `if: ${guard}`);
  }
  const script = /node --input-type=module <<'JS'\n([\s\S]*?)          JS/u.exec(workflow)?.[1];
  assert.ok(script, "workflow must validate the planned shard set");
  const validate = (groups) => execFileSync("node", ["--input-type=module", "-e", script], { env: { ...process.env, LEAK_GROUPS: JSON.stringify(groups) }, stdio: "pipe" });
  for (const shard of ["call-leaks-2", "call-leaks-3"]) assert.throws(() => validate(["checks", shard]), /Incomplete leak shard plan/u);
  assert.doesNotThrow(() => validate(["checks", "call-leaks-1", "call-leaks-2", "call-leaks-3"]));
  assert.doesNotThrow(() => validate(["checks"]));
});
