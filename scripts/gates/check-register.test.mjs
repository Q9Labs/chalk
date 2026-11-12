import assert from "node:assert/strict";
import test from "node:test";
import { findProblems } from "./check-register.mjs";
import { gateTaskIds, readRegister, requireRegistered } from "./register.mjs";

const entry = (overrides = {}) => ({
  id: "gate:example",
  area: "Gate",
  catches: "A change that breaks the example.",
  runs: ["pull_request"],
  blocks: "merge",
  minutes: 1,
  record: "unmeasured",
  sample: "No history.",
  ...overrides,
});

const shapeProblems = (overrides) => findProblems([entry(overrides)]).filter((problem) => problem.startsWith("gate:example:") && !problem.includes("planner has no task"));

test("the repository register covers every workflow job, hook command, Gate lane and budget group", () => {
  assert.deepEqual(findProblems(), []);
});

test("every Gate lane in the register runs from the same list the planner builds", () => {
  assert.ok(gateTaskIds().includes("register"));
  assert.doesNotThrow(() => requireRegistered("types"));
  assert.throws(() => requireRegistered("not-a-lane"), /no entry in scripts\/gates\/checks.json/);
});

test("a workflow job, hook command or budget group without an entry is a problem", () => {
  const without = (prefix) => readRegister().filter((candidate) => !candidate.id.startsWith(prefix));
  assert.ok(findProblems(without("workflow:gate.yml#api")).some((problem) => problem.startsWith("workflow:gate.yml#api:")));
  assert.ok(findProblems(without("hook:")).some((problem) => problem.startsWith("hook:pre-commit/fast-gate:")));
  assert.ok(findProblems(without("scorecard:web.laptop")).some((problem) => problem.startsWith("scorecard:web.laptop:")));
  assert.ok(findProblems(without("gate:types")).some((problem) => problem.startsWith("gate:types:")));
});

test("an entry for a check that no longer exists is a problem", () => {
  const stale = [...readRegister(), entry({ id: "workflow:gone.yml#job" })];
  assert.ok(findProblems(stale).some((problem) => problem.startsWith("workflow:gone.yml#job: no workflow by this name")));
});

test("a check that blocks nothing and has no reason is rejected", () => {
  assert.equal(shapeProblems({ blocks: "nothing" }).length, 1);
  assert.equal(shapeProblems({ blocks: "advisory" }).length, 1);
  assert.equal(shapeProblems({ blocks: "advisory", reason: "Only a ruleset change can make it block." }).length, 0);
});

test("a purpose must be one sentence, and a merge block must run before a merge", () => {
  assert.equal(shapeProblems({ catches: "No full stop" }).length, 1);
  assert.equal(shapeProblems({ catches: "x".repeat(230) + "." }).length, 1);
  assert.equal(shapeProblems({ runs: ["daily"] }).length, 1);
  assert.equal(shapeProblems({ blocks: "release", runs: ["pull_request"] }).length, 1);
});
