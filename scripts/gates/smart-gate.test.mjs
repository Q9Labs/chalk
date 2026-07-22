import assert from "node:assert/strict";
import test from "node:test";

import { createGatePlan, parseArguments } from "./smart-gate.mjs";

const workspaces = [
  { name: "@q9labsai/chalk-client", directory: "sdks/typescript/client", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: [], isPublic: true },
  { name: "@q9labsai/chalk-react", directory: "sdks/typescript/react", scripts: { build: "build", "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client"], isPublic: true },
  { name: "web", directory: "apps/web", scripts: { build: "build" }, dependencies: ["@q9labsai/chalk-react"], isPublic: false },
  { name: "@chalk/meeting-broker", directory: "infrastructure/meeting-broker", scripts: { "check-types": "types", test: "test" }, dependencies: ["@q9labsai/chalk-client"], isPublic: false },
];

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

test("meeting broker changes select its type check and coverage tests", () => {
  const plan = createGatePlan(["infrastructure/meeting-broker/src/worker.ts"], { workspaces });
  const typeTask = plan.tasks.find((task) => task.id === "types");
  const testTask = plan.tasks.find((task) => task.id === "tests");
  assert.equal(plan.full, false);
  assert.deepEqual(typeTask.command, ["pnpm", "--filter", "@chalk/meeting-broker", "run", "check-types"]);
  assert.deepEqual(testTask.command, ["pnpm", "--filter", "@chalk/meeting-broker", "run", "test", "--coverage"]);
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
  assert.match(services.command.join(" "), /apps\/sync\/scripts\/gate\.sh/);
  assert.equal(services.env.CHALK_SYNC_GATE_MODE, "basic");
});

test("lockfile changes select all JavaScript workspaces and dependency checks", () => {
  const plan = createGatePlan(["pnpm-lock.yaml"], { workspaces });
  assert.equal(selected(plan, "osv"), true);
  assert.equal(selected(plan, "syncpack"), true);
  assert.match(plan.tasks.find((task) => task.id === "build").reason, /web/);
});

test("gate definitions and unknown paths fail closed to full scope", () => {
  assert.equal(createGatePlan(["scripts/gates/commit.sh"], { workspaces }).full, true);
  assert.equal(createGatePlan(["experimental/runtime.xyz"], { workspaces }).full, true);
});

test("architecture generation runs before changed-code analysis", () => {
  const plan = createGatePlan(["architecture.html"], { workspaces });
  const selectedTasks = plan.tasks.filter((task) => task.selected).map((task) => task.id);
  assert.ok(selectedTasks.indexOf("architecture") < selectedTasks.indexOf("fallow"));
});

test("pnpm argument separator and explicit full mode select substantive whole-repository checks", () => {
  assert.deepEqual(parseArguments(["--", "--full"]), { full: true });
  const plan = createGatePlan([], { full: true, workspaces });
  assert.equal(selected(plan, "format"), false);
  assert.deepEqual(plan.tasks.find((task) => task.id === "fallow").command, ["pnpm", "run", "static:fallow"]);
  assert.deepEqual(plan.tasks.find((task) => task.id === "semgrep").command, ["bash", "scripts/gates/semgrep.sh"]);
});
