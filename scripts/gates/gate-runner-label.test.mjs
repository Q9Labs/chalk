import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");

const hostedLabels = ["ubuntu-24.04", "ubuntu-slim"];
const guard = "(github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch')";
const runnerExpression = (fallback, except = "") => `\${{ ${guard} &&${except} (inputs.runner || vars.CHALK_GATE_RUNNER) || '${fallback}' }}`;
// The sfu lane keeps the hosted runner while its TWCC test fails on Instabox (see the comment in gate.yml).
const sfuOnHosted = runnerExpression("ubuntu-24.04", " matrix.group != 'sfu' &&");

const runsOn = [...workflow.matchAll(/^ {4}runs-on: (.+)$/gmu)].map((match) => match[1]);

test("every Gate job takes its runner from the same expression and falls back to a hosted label", () => {
  assert.equal(runsOn.length, 8);
  for (const value of runsOn) {
    const fallback = hostedLabels.find((label) => value === runnerExpression(label));
    assert.ok(fallback || value === sfuOnHosted, `runs-on is not the shared expression: ${value}`);
  }
});

test("only the root lanes job keeps a lane on the hosted runner, and it is the sfu lane", () => {
  assert.equal(runsOn.filter((value) => value === sfuOnHosted).length, 1);
  assert.match(workflow, /root-lanes:\n(?: {4}.+\n)*? {4}runs-on: .*matrix\.group != 'sfu'/u);
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
