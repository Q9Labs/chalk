import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");

const hostedLabels = ["ubuntu-24.04", "ubuntu-slim"];
const runnerExpression = (fallback) => `\${{ (github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch') && (inputs.runner || vars.CHALK_GATE_RUNNER) || '${fallback}' }}`;

const runsOn = [...workflow.matchAll(/^ {4}runs-on: (.+)$/gmu)].map((match) => match[1]);

test("every Gate job takes its runner from the same expression and falls back to a hosted label", () => {
  assert.equal(runsOn.length, 7);
  for (const value of runsOn) {
    const fallback = hostedLabels.find((label) => value === runnerExpression(label));
    assert.ok(fallback, `runs-on is not the shared expression: ${value}`);
  }
});

test("a pull request never reaches the runner variable, so a fork cannot run on our machines", () => {
  for (const value of runsOn) {
    assert.ok(!value.includes("pull_request"), value);
    assert.ok(value.startsWith("${{ (github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch') &&"), value);
  }
});

test("the manual run offers a runner input that is empty by default", () => {
  assert.match(workflow, /workflow_dispatch:\n {4}inputs:\n {6}runner:\n(?: {8}.+\n)*? {8}default: ""\n/u);
});
