import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGatePlan, discoverWorkspaces, parseArguments, resolveChangedFiles } from "./smart-gate.mjs";

const gitLocalEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

const workspaces = [
  { name: "@q9labsai/chalk-client", directory: "sdks/typescript/client", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: [], isPublic: true },
  { name: "@q9labsai/chalk-react", directory: "sdks/typescript/react", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client"], isPublic: true },
  { name: "web", directory: "apps/web", scripts: { build: "build" }, dependencies: ["@q9labsai/chalk-react"], isPublic: false },
  { name: "@chalk/episode-broker", directory: "infrastructure/episode-broker", scripts: { "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client"], isPublic: false },
];

const targetWorkspaces = [
  { name: "@q9labsai/chalk-client", directory: "sdks/typescript/client", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/diagnostics-contracts"], isPublic: true },
  { name: "@q9labsai/diagnostics-contracts", directory: "packages/diagnostics-contracts", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: [], isPublic: true },
  { name: "@q9labsai/chalk-react", directory: "sdks/typescript/react", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client", "@q9labsai/chalk-whiteboard", "@q9labsai/facehash"], isPublic: true },
  { name: "@q9labsai/chalk-react-native", directory: "sdks/typescript/react-native", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client", "@q9labsai/chalk-whiteboard", "@q9labsai/facehash"], isPublic: true },
  { name: "@q9labsai/chalk-whiteboard", directory: "packages/whiteboard", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: [], isPublic: true },
  { name: "@q9labsai/facehash", directory: "packages/facehash", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: [], isPublic: true },
  { name: "web", directory: "apps/web", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-react"], isPublic: false },
  { name: "@q9labsai/chalk-mobile", directory: "apps/mobile", scripts: { build: "pnpm run prepare:native-dependencies && expo export", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-react-native"], isPublic: false },
  { name: "@chalk/sdk-web-consumer-e2e", directory: "tools/sdk-web-consumer-e2e", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-react"], isPublic: false },
  { name: "@chalk/episode-broker", directory: "infrastructure/episode-broker", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client"], isPublic: false },
  { name: "@chalk/presence-broker", directory: "infrastructure/presence-broker", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client"], isPublic: false },
  { name: "@chalk/contract-fixture-proof", directory: "tools/contract-fixture-proof", scripts: { "check-types": "types", test: "test" }, dependencies: [], isPublic: false },
];

function withoutGitRepositoryEnvironment(environment = process.env) {
  const isolated = { ...environment };
  for (const name of gitLocalEnvironmentVariables) delete isolated[name];
  return isolated;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: withoutGitRepositoryEnvironment() }).trim();
}

function writeWorkspaceManifest(root, directory, packageJson) {
  const manifest = path.join(root, directory, "package.json");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify(packageJson)}\n`);
}

function runSmartGateWithFakeNode(files, args, exitCode = 99) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "chalk-smart-gate-cli-"));
  const bin = path.join(sandbox, "bin");
  const marker = path.join(sandbox, "task-marker");
  mkdirSync(bin, { recursive: true });
  const fakeNode = path.join(bin, "node");
  writeFileSync(fakeNode, `#!/bin/sh\nprintf 'TASK_MARKER\\n' >> "$SMART_GATE_MARKER"\nprintf 'TASK_MARKER\\n'\nexit ${exitCode}\n`);
  chmodSync(fakeNode, 0o755);
  const script = fileURLToPath(new URL("./smart-gate.mjs", import.meta.url));
  try {
    const environment = withoutGitRepositoryEnvironment();
    delete environment.GATE_TARGET;
    const output = execFileSync(process.execPath, [script, ...args], {
      cwd: path.resolve(path.dirname(script), "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, GATE_FILES: files.join(","), PATH: `${bin}:${process.env.PATH ?? ""}`, SMART_GATE_MARKER: marker },
    });
    return { status: 0, output, marker: existsSync(marker) };
  } catch (error) {
    return {
      status: error.status,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      marker: existsSync(marker),
    };
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
  }
}

function selected(plan, id) {
  return plan.tasks.find((task) => task.id === id)?.selected;
}

test("documentation changes stay lightweight", () => {
  const plan = createGatePlan(["docs/design.md"], { workspaces });
  assert.equal(plan.full, false);
  assert.equal(selected(plan, "services"), false);
  assert.equal(selected(plan, "tests"), false);
  assert.equal(selected(plan, "secrets"), true);
});

test("client changes include transitive workspace dependents and one test task", () => {
  const plan = createGatePlan(["sdks/typescript/client/src/index.ts"], { workspaces });
  const testTask = plan.tasks.find((task) => task.id === "tests");
  assert.equal(testTask.selected, true);
  assert.match(testTask.reason, /chalk-client/);
  assert.match(testTask.reason, /chalk-react/);
  assert.match(testTask.reason, /web/);
  assert.deepEqual(
    plan.tasks.filter((task) => task.id === "tests").map((task) => task.id),
    ["tests"],
  );
  assert.equal(testTask.command.at(-1), "--coverage");
});

test("Episode broker changes select its type check and coverage tests", () => {
  const plan = createGatePlan(["infrastructure/episode-broker/src/worker.ts"], { workspaces });
  const typeTask = plan.tasks.find((task) => task.id === "types");
  const testTask = plan.tasks.find((task) => task.id === "tests");
  assert.equal(plan.full, false);
  assert.deepEqual(typeTask.command, ["pnpm", "--workspace-concurrency=1", "--sort", "--filter", "@chalk/episode-broker", "run", "check-types"]);
  assert.deepEqual(testTask.command, ["pnpm", "--filter", "@chalk/episode-broker", "run", "test", "--coverage"]);
});

test("API changes select migrated service gates and contracts", () => {
  const plan = createGatePlan(["apps/api/internal/httpapi/router.go"], { workspaces });
  assert.equal(selected(plan, "services"), true);
  assert.equal(selected(plan, "contracts"), true);
  assert.match(plan.tasks.find((task) => task.id === "services").command.join(" "), /apps\/api\/scripts\/gate\.sh/);
});

test("Sync changes are part of the global gate", () => {
  const plan = createGatePlan(["apps/sync/lib/chalk_sync/application.ex"], { workspaces });
  assert.equal(selected(plan, "services"), true);
  const services = plan.tasks.find((task) => task.id === "services");
  assert.match(services.command.join(" "), /apps\/sync\/scripts\/reliability-correctness/);
  assert.equal(services.env.CHALK_SYNC_GATE_MODE, undefined);
});

test("whiteboard and SDK transport changes run the shared Sync correctness profile", () => {
  for (const file of ["packages/whiteboard/src/collab/client.ts", "sdks/typescript/client/src/sync/client.ts", "sdks/typescript/client/src/whiteboard/client.ts", "contract/schema/whiteboard-v1.json"]) {
    const services = createGatePlan([file], { workspaces }).tasks.find((task) => task.id === "services");
    assert.equal(services.selected, true, file);
    assert.match(services.command.join(" "), /reliability-correctness/, file);
  }
});

test("lockfile changes select all JavaScript workspaces and dependency checks", () => {
  const plan = createGatePlan(["pnpm-lock.yaml"], { workspaces });
  assert.equal(selected(plan, "osv"), true);
  assert.equal(selected(plan, "syncpack"), true);
  assert.match(plan.tasks.find((task) => task.id === "build").reason, /web/);
});

test("workspace type checks run one at a time in dependency order", () => {
  const typeTask = createGatePlan(["pnpm-lock.yaml"], { workspaces }).tasks.find((task) => task.id === "types");
  assert.deepEqual(typeTask.command, ["pnpm", "--workspace-concurrency=1", "--sort", "--filter", "@q9labsai/chalk-client", "--filter", "@q9labsai/chalk-react", "--filter", workspaces[3].name, "run", "check-types"]);
});

test("workspace builds run one at a time in dependency order", () => {
  const buildTask = createGatePlan(["pnpm-lock.yaml"], { workspaces }).tasks.find((task) => task.id === "build");
  assert.deepEqual(buildTask.command, ["pnpm", "--workspace-concurrency=1", "--sort", "--filter", "@q9labsai/chalk-client", "--filter", "@q9labsai/chalk-react", "--filter", "web", "run", "build"]);
});

test("gate definitions and unknown paths fail closed to full scope", () => {
  assert.equal(createGatePlan(["scripts/gates/commit.sh"], { workspaces }).full, true);
  assert.equal(createGatePlan([".github/workflows/sync-reliability.yml"], { workspaces }).full, true);
  assert.equal(createGatePlan(["experimental/runtime.xyz"], { workspaces }).full, true);
});

test("architecture generation runs before changed-code analysis", () => {
  const plan = createGatePlan(["architecture.html"], { workspaces });
  const selectedTasks = plan.tasks.filter((task) => task.selected).map((task) => task.id);
  assert.ok(selectedTasks.indexOf("architecture") < selectedTasks.indexOf("fallow"));
});

test("pnpm argument separator and explicit full mode select substantive whole-repository checks", () => {
  assert.deepEqual(parseArguments(["--", "--full"], {}), { full: true });
  const plan = createGatePlan([], { full: true, workspaces });
  assert.equal(selected(plan, "format"), false);
  assert.deepEqual(plan.tasks.find((task) => task.id === "fallow").command, ["pnpm", "run", "static:fallow"]);
  assert.deepEqual(plan.tasks.find((task) => task.id === "semgrep").command, ["bash", "scripts/gates/semgrep.sh"]);
});

test("shipment targets accept CLI and environment forms", () => {
  assert.deepEqual(parseArguments(["--", "--target", "web"], {}), { full: false, target: "web" });
  assert.deepEqual(parseArguments(["--target=mobile"], {}), { full: false, target: "mobile" });
  assert.deepEqual(parseArguments([], { GATE_TARGET: "web" }), { full: false, target: "web" });
  assert.deepEqual(parseArguments(["--target=web"], { GATE_TARGET: "web" }), { full: false, target: "web" });
  assert.throws(
    () => parseArguments(["--target", "web"], { GATE_TARGET: "mobile" }),
    (error) => error.reason === "target-conflict",
  );
  for (const [argv, environment, reason] of [
    [["--target"], {}, "invalid-target"],
    [["--target="], {}, "invalid-target"],
    [["--target", ""], {}, "invalid-target"],
    [["--target", "tablet"], {}, "invalid-target"],
    [["--target", "web", "--target", "web"], {}, "invalid-target"],
    [["--target", "web", "--unknown"], {}, "invalid-target"],
    [["--unknown"], { GATE_TARGET: "web" }, "invalid-target"],
    [["--target", "web"], { GATE_TARGET: "" }, "invalid-target"],
    [["--target", "web"], { GATE_TARGET: "tablet" }, "target-conflict"],
    [["--full", "--target", "web"], {}, "target-with-full"],
    [["--full"], { GATE_TARGET: "mobile" }, "target-with-full"],
  ]) {
    const invoke = () => parseArguments(argv, environment);
    assert.throws(invoke, (error) => error.reason === reason, `${argv.join(" ")} / ${JSON.stringify(environment)}`);
  }
});

test("web target removes only affected mobile-exclusive workspaces", () => {
  const plan = createGatePlan(["sdks/typescript/client/src/index.ts"], { target: "web", workspaces: targetWorkspaces, source: "explicit", scope: "explicit" });
  assert.equal(plan.mode, "targeted");
  assert.equal(plan.target, "web");
  assert.equal(plan.source, "explicit");
  assert.deepEqual(
    plan.excludedWorkspaces.map((workspace) => workspace.name),
    ["@q9labsai/chalk-react-native", "@q9labsai/chalk-mobile"],
  );
  assert.deepEqual(
    plan.selectedWorkspaces.map((workspace) => workspace.name),
    ["@q9labsai/chalk-client", "@q9labsai/chalk-react", "web", "@chalk/sdk-web-consumer-e2e", "@chalk/episode-broker", "@chalk/presence-broker"],
  );
});

test("mobile target removes only affected web-exclusive workspaces", () => {
  const plan = createGatePlan(["sdks/typescript/client/src/index.ts"], { target: "mobile", workspaces: targetWorkspaces, source: "explicit", scope: "explicit" });
  assert.deepEqual(
    plan.excludedWorkspaces.map((workspace) => workspace.name),
    ["@q9labsai/chalk-react", "web", "@chalk/sdk-web-consumer-e2e"],
  );
  assert.equal(
    plan.selectedWorkspaces.some((workspace) => workspace.name === "@chalk/episode-broker"),
    true,
  );
  assert.equal(
    plan.selectedWorkspaces.some((workspace) => workspace.name === "@q9labsai/chalk-react-native"),
    true,
  );
});

test("whiteboard target plans keep Sync reliability and the owning mobile prepare lane", () => {
  const webPlan = createGatePlan(["packages/whiteboard/src/collab/client.ts"], { target: "web", workspaces: targetWorkspaces });
  const mobilePlan = createGatePlan(["packages/whiteboard/src/collab/client.ts"], { target: "mobile", workspaces: targetWorkspaces });
  for (const plan of [webPlan, mobilePlan]) {
    const services = plan.tasks.find((task) => task.id === "services");
    assert.equal(services.selected, true);
    assert.match(services.command.join(" "), /reliability-correctness/);
    assert.equal(
      plan.selectedWorkspaces.some((workspace) => workspace.name === "@q9labsai/chalk-whiteboard"),
      true,
    );
  }
  const mobileBuild = mobilePlan.tasks.find((task) => task.id === "build");
  const mobileWorkspace = mobilePlan.selectedWorkspaces.find((workspace) => workspace.name === "@q9labsai/chalk-mobile");
  assert.match(mobileBuild.command.join(" "), /@q9labsai\/chalk-mobile/);
  assert.match(mobileWorkspace.scripts.build, /prepare:native-dependencies/);
  assert.doesNotMatch(webPlan.tasks.find((task) => task.id === "build").command.join(" "), /@q9labsai\/chalk-mobile/);
});

test("facehash changes stay shared while each target removes the opposite consumer lane", () => {
  const plans = [
    { target: "web", opposite: ["@q9labsai/chalk-react-native", "@q9labsai/chalk-mobile"], selected: ["@q9labsai/facehash", "@q9labsai/chalk-react", "web"] },
    { target: "mobile", opposite: ["@q9labsai/chalk-react", "web", "@chalk/sdk-web-consumer-e2e"], selected: ["@q9labsai/facehash", "@q9labsai/chalk-react-native", "@q9labsai/chalk-mobile"] },
  ];
  for (const variant of plans) {
    const plan = createGatePlan(["packages/facehash/src/index.ts"], { target: variant.target, workspaces: targetWorkspaces });
    const names = plan.selectedWorkspaces.map((workspace) => workspace.name);
    for (const workspace of variant.selected) assert.equal(names.includes(workspace), true, `${variant.target}/${workspace}`);
    for (const workspace of variant.opposite) assert.equal(names.includes(workspace), false, `${variant.target}/${workspace}`);
  }
});

test("contract fixture changes keep the fixture workspace and contract route in either target", () => {
  for (const target of ["web", "mobile"]) {
    const plan = createGatePlan(["tools/contract-fixture-proof/src/cli.mjs"], { target, workspaces: targetWorkspaces });
    assert.equal(selected(plan, "contracts"), true, target);
    assert.match(plan.tasks.find((task) => task.id === "types").command.join(" "), /@chalk\/contract-fixture-proof/);
    assert.match(plan.tasks.find((task) => task.id === "tests").command.join(" "), /@chalk\/contract-fixture-proof/);
  }
});

test("recorder changes keep the existing recorder route in either target", () => {
  for (const target of ["web", "mobile"]) {
    const plan = createGatePlan(["infrastructure/recorder/src/index.ts"], { target, workspaces: targetWorkspaces });
    const recorder = plan.tasks.find((task) => task.id === "recorder");
    assert.equal(recorder.selected, true, target);
    assert.match(recorder.command.join(" "), /recorder:gate/);
  }
});

test("client target plans remove every opposite platform workspace command", () => {
  const checks = ["types", "tests", "build", "publint", "attw"];
  const variants = [
    { target: "web", selected: ["@q9labsai/chalk-client", "@q9labsai/chalk-react"], opposite: ["@q9labsai/chalk-mobile", "@q9labsai/chalk-react-native"] },
    { target: "mobile", selected: ["@q9labsai/chalk-client", "@q9labsai/chalk-react-native"], opposite: ["web", "@q9labsai/chalk-react", "@chalk/sdk-web-consumer-e2e"] },
  ];
  for (const variant of variants) {
    const plan = createGatePlan(["sdks/typescript/client/src/index.ts"], { target: variant.target, workspaces: targetWorkspaces });
    for (const id of checks) {
      const candidate = plan.tasks.find((task) => task.id === id);
      assert.equal(candidate.selected, true, `${variant.target}/${id}`);
      for (const workspace of variant.opposite) assert.equal(candidate.command.includes(workspace), false, `${variant.target}/${id}/${workspace}`);
      for (const workspace of variant.selected) assert.equal(candidate.command.includes(workspace), true, `${variant.target}/${id}/${workspace}`);
    }
    for (const id of ["types", "tests", "build"]) {
      const command = plan.tasks.find((task) => task.id === id).command;
      assert.equal(command.includes("@chalk/episode-broker"), true, `${variant.target}/${id}/episode-broker`);
      assert.equal(command.includes("@chalk/presence-broker"), true, `${variant.target}/${id}/presence-broker`);
    }
  }
});

test("target mismatch rejects incompatible direct changes before checks", () => {
  assert.throws(
    () => createGatePlan(["sdks/typescript/react/src/index.ts"], { target: "mobile", workspaces: targetWorkspaces }),
    (error) => error.reason === "target-mismatch" && error.target === "mobile" && error.suggestion === "pnpm run gate" && error.details.includes("sdks/typescript/react/src/index.ts"),
  );
  assert.throws(
    () => createGatePlan(["scripts/gates/README.md"], { target: "web", workspaces: targetWorkspaces }),
    (error) => error.reason === "full-required" && error.suggestion === "pnpm run gate -- --full",
  );
  assert.throws(
    () => createGatePlan(["pnpm-lock.yaml"], { target: "web", workspaces: targetWorkspaces }),
    (error) => error.reason === "full-required" && error.suggestion === "pnpm run gate -- --full",
  );
});

test("mixed web and mobile changes reject either shipment target", () => {
  const files = ["sdks/typescript/react/src/index.ts", "sdks/typescript/react-native/src/index.ts"];
  for (const target of ["web", "mobile"]) {
    assert.throws(
      () => createGatePlan(files, { target, workspaces: targetWorkspaces }),
      (error) => error.reason === "target-mismatch" && error.details.includes(target === "web" ? files[1] : files[0]),
      target,
    );
  }
});

test("React Native changes reject a web shipment target", () => {
  assert.throws(
    () => createGatePlan(["sdks/typescript/react-native/src/index.ts"], { target: "web", workspaces: targetWorkspaces }),
    (error) => error.reason === "target-mismatch" && error.details.includes("sdks/typescript/react-native/src/index.ts"),
  );
});

test("diagnostics contracts route through generated contract checks in either target", () => {
  for (const target of ["web", "mobile"]) {
    const plan = createGatePlan(["packages/diagnostics-contracts/src/index.ts"], { target, workspaces: targetWorkspaces });
    assert.equal(selected(plan, "contracts"), true, target);
  }
});

test("ordinary documentation target runs global checks without workspace work", () => {
  for (const target of ["web", "mobile"]) {
    const plan = createGatePlan(["docs/design.md"], { target, workspaces: targetWorkspaces });
    assert.equal(plan.mode, "targeted");
    assert.equal(plan.full, false);
    assert.deepEqual(plan.selectedWorkspaces, []);
    assert.equal(plan.tasks.find((task) => task.id === "self-test").selected, true);
    assert.equal(plan.tasks.find((task) => task.id === "language-ratchet").selected, true);
    assert.equal(plan.tasks.find((task) => task.id === "hygiene").selected, true);
    assert.equal(plan.tasks.find((task) => task.id === "secrets").selected, true);
    assert.equal(plan.tasks.find((task) => task.id === "types").selected, false);
    assert.equal(plan.tasks.find((task) => task.id === "tests").selected, false);
    assert.equal(plan.tasks.find((task) => task.id === "build").selected, false);
  }
});

test("root configuration and unknown target changes require full mode", () => {
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "package.json", "scripts/gates/README.md", "experimental/runtime.xyz"]) {
    assert.throws(
      () => createGatePlan([file], { target: "web", workspaces: targetWorkspaces }),
      (error) => error.reason === "full-required" && error.suggestion === "pnpm run gate -- --full",
      file,
    );
  }
});

test("target planning errors exit 2 before any gate task subprocess starts", () => {
  for (const [files, args] of [
    [["sdks/typescript/react/src/index.ts"], ["--target", "mobile"]],
    [["pnpm-lock.yaml"], ["--target", "web"]],
  ]) {
    const result = runSmartGateWithFakeNode(files, args, 17);
    assert.equal(result.status, 2, `${files.join(",")} / ${args.join(" ")}`);
    assert.equal(result.marker, false, `${files.join(",")} / ${args.join(" ")}`);
  }
});

test("plan observability precedes task output and gate failures preserve subprocess status", () => {
  const result = runSmartGateWithFakeNode(["docs/design.md"], ["--target", "web"], 7);
  assert.equal(result.status, 7);
  assert.equal(result.marker, true);
  const marker = result.output.indexOf("TASK_MARKER");
  assert.ok(marker > 0);
  for (const line of ["Gate plan: mode=targeted target=web source=explicit", "Gate workspaces: selected=none", "Gate exclusions: opposite-platform=none", "Gate checks: selected="]) {
    assert.ok(result.output.indexOf(line) >= 0, line);
    assert.ok(result.output.indexOf(line) < marker, line);
  }
});

test("full mode has no shipment target and retains the full task model", () => {
  const plan = createGatePlan([], { full: true, workspaces: targetWorkspaces });
  assert.equal(plan.mode, "full");
  assert.equal(plan.target, null);
  assert.deepEqual(plan.excludedWorkspaces, []);
  assert.equal(plan.tasks.find((task) => task.id === "types").selected, true);
  assert.equal(plan.tasks.find((task) => task.id === "tests").selected, true);
  assert.equal(plan.tasks.find((task) => task.id === "build").selected, true);
});

test("explicit paths reject absolute, traversal, and duplicate-separator inputs", () => {
  for (const file of ["/tmp/chalk.ts", "sdks/typescript/../client/src/index.ts", "sdks//typescript/client/src/index.ts", ""]) {
    assert.throws(
      () => createGatePlan([file], { workspaces }),
      (error) => error.reason === "invalid-path",
      file,
    );
  }
});

test("target planning fails closed for missing roots and malformed workspace metadata", () => {
  assert.throws(
    () => createGatePlan(["sdks/typescript/client/src/index.ts"], { target: "web", workspaces: targetWorkspaces.filter((workspace) => workspace.name !== "web") }),
    (error) => error.reason === "missing-target-root",
  );
  assert.throws(
    () => createGatePlan([], { workspaces: [{ name: "broken", directory: "apps/broken", scripts: null, dependencies: [] }] }),
    (error) => error.reason === "workspace-metadata",
  );
  assert.throws(
    () => createGatePlan([], { workspaces: [{ name: "broken", directory: "apps/broken", scripts: {}, dependencies: {} }] }),
    (error) => error.reason === "workspace-metadata",
  );
  assert.throws(
    () =>
      createGatePlan([], {
        workspaces: [
          { name: "duplicate", directory: "apps/one", scripts: {}, dependencies: [] },
          { name: "duplicate", directory: "apps/two", scripts: {}, dependencies: [] },
        ],
      }),
    (error) => error.reason === "workspace-metadata",
  );
});

test("workspace manifest snapshots isolate staged index and requested ref from dirty worktree metadata", () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), "chalk-smart-gate-"));
  try {
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "gate-tests@example.invalid"]);
    git(repository, ["config", "user.name", "Gate tests"]);
    writeWorkspaceManifest(repository, "apps/web", { name: "web-base", scripts: { test: "base-test" }, dependencies: {} });
    git(repository, ["add", "."]);
    git(repository, ["commit", "-qm", "base"]);

    writeWorkspaceManifest(repository, "apps/web", { name: "web-index", scripts: { test: "index-test" }, dependencies: { "@internal/index": "1.0.0" } });
    git(repository, ["add", "apps/web/package.json"]);
    writeWorkspaceManifest(repository, "apps/web", { name: "web-dirty", scripts: { test: "dirty-test" }, dependencies: { "@internal/dirty": "1.0.0" } });

    const environment = withoutGitRepositoryEnvironment();
    const staged = discoverWorkspaces(repository, { snapshot: { mode: "index" }, environment });
    const worktree = discoverWorkspaces(repository, { snapshot: { mode: "worktree" }, environment });
    assert.equal(staged.find((workspace) => workspace.directory === "apps/web").name, "web-index");
    assert.equal(staged.find((workspace) => workspace.directory === "apps/web").scripts.test, "index-test");
    assert.equal(worktree.find((workspace) => workspace.directory === "apps/web").name, "web-dirty");
    assert.equal(worktree.find((workspace) => workspace.directory === "apps/web").scripts.test, "dirty-test");

    git(repository, ["commit", "-qm", "index"]);
    const head = git(repository, ["rev-parse", "HEAD"]);
    writeWorkspaceManifest(repository, "apps/web", { name: "web-dirty-again", scripts: { test: "dirty-again-test" }, dependencies: {} });
    const fromHead = discoverWorkspaces(repository, { snapshot: { mode: "ref", ref: head }, environment });
    assert.equal(fromHead.find((workspace) => workspace.directory === "apps/web").name, "web-index");
    assert.equal(fromHead.find((workspace) => workspace.directory === "apps/web").scripts.test, "index-test");
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("targeted Git snapshots include deletions and both sides of renames", () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), "chalk-smart-gate-target-paths-"));
  try {
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "gate-tests@example.invalid"]);
    git(repository, ["config", "user.name", "Gate tests"]);
    const renamedSource = "apps/mobile/src/renamed.ts";
    const deletedSource = "apps/mobile/src/deleted.ts";
    const renamedDestination = "packages/whiteboard/src/renamed.ts";
    for (const file of [renamedSource, deletedSource]) {
      const absolute = path.join(repository, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, "export const fixture = true;\n");
    }
    git(repository, ["add", "."]);
    git(repository, ["commit", "-qm", "base"]);
    mkdirSync(path.dirname(path.join(repository, renamedDestination)), { recursive: true });
    git(repository, ["mv", renamedSource, renamedDestination]);
    rmSync(path.join(repository, deletedSource));
    git(repository, ["add", "-A"]);

    const environment = withoutGitRepositoryEnvironment();
    for (const name of ["CI", "GATE_BASE_REF", "GATE_FILES", "GATE_HEAD_REF"]) delete environment[name];
    const automatic = resolveChangedFiles({ repositoryRoot: repository, environment });
    const targeted = resolveChangedFiles({ repositoryRoot: repository, environment, target: "web" });
    assert.deepEqual(automatic.files, [renamedDestination]);
    assert.deepEqual(targeted.files, [deletedSource, renamedSource, renamedDestination].sort());
    assert.throws(
      () => createGatePlan(targeted.files, { target: "web", workspaces: targetWorkspaces, repositoryRoot: repository }),
      (error) => error.reason === "target-mismatch" && error.details.includes(deletedSource) && error.details.includes(renamedSource),
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("change source precedence favors explicit files over CI and staged input", () => {
  const previous = { GATE_FILES: process.env.GATE_FILES, CI: process.env.CI, GATE_BASE_REF: process.env.GATE_BASE_REF };
  try {
    process.env.GATE_FILES = "docs/explicit.md";
    process.env.CI = "true";
    process.env.GATE_BASE_REF = "origin/master";
    assert.deepEqual(resolveChangedFiles({}, "ACMR").source, "explicit");
  } finally {
    if (previous.GATE_FILES === undefined) delete process.env.GATE_FILES;
    else process.env.GATE_FILES = previous.GATE_FILES;
    if (previous.CI === undefined) delete process.env.CI;
    else process.env.CI = previous.CI;
    if (previous.GATE_BASE_REF === undefined) delete process.env.GATE_BASE_REF;
    else process.env.GATE_BASE_REF = previous.GATE_BASE_REF;
  }
});
