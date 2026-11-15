import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");

const hostedLabels = ["ubuntu-24.04", "ubuntu-slim"];
const guard = "(github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch')";
// Two sizes of Instabox runner: big is 4x8 for the jobs that need it, small is 2x4 for the rest, and small falls back to big.
const big = "(inputs.runner || vars.CHALK_GATE_RUNNER)";
const small = "(inputs.runner_small || inputs.runner || vars.CHALK_GATE_RUNNER && (vars.CHALK_GATE_RUNNER_SMALL || vars.CHALK_GATE_RUNNER))";
const runnerExpression = (size, fallback) => `\${{ ${guard} && ${size} || '${fallback}' }}`;
// The sfu lane keeps the hosted runner while its TWCC test fails on Instabox (see the comment in gate.yml), and the
// browser-tests lane needs the big runner (3.7 GB of a 2x4 machine's 3.9 GB).
const rootLanes = `\${{ ${guard} && matrix.group != 'sfu' && (matrix.group == 'browser-tests' && ${big} || ${small}) || 'ubuntu-24.04' }}`;

const runsOn = [...workflow.matchAll(/^ {4}runs-on: (.+)$/gmu)].map((match) => match[1]);

test("every Gate job takes its runner from a shared expression and falls back to a hosted label", () => {
  assert.equal(runsOn.length, 8);
  for (const value of runsOn) {
    const shared = hostedLabels.some((label) => value === runnerExpression(small, label) || value === runnerExpression(big, label));
    assert.ok(shared || value === rootLanes, `runs-on is not a shared expression: ${value}`);
  }
});

test("only the API gate and the browser-tests lane use the big runner, and the sfu lane stays hosted", () => {
  assert.equal(runsOn.filter((value) => value === rootLanes).length, 1);
  assert.match(workflow, /root-lanes:\n(?: {4}.+\n)*? {4}runs-on: .*matrix\.group != 'sfu'/u);
  const bigJobs = runsOn.filter((value) => hostedLabels.some((label) => value === runnerExpression(big, label)));
  assert.equal(bigJobs.length, 1);
  assert.match(workflow, /\n {2}api:\n(?: {4}.+\n)*? {4}runs-on: \$\{\{ [^\n]*\) && \(inputs\.runner \|\| vars\.CHALK_GATE_RUNNER\) \|\|/u);
});

test("a pull request never reaches the runner variable, so a fork cannot run on our machines", () => {
  for (const value of runsOn) {
    assert.ok(!value.includes("pull_request"), value);
    assert.ok(value.startsWith("${{ (github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch') &&"), value);
  }
});

test("the manual run offers runner and runner_small inputs that are empty by default", () => {
  assert.match(workflow, /workflow_dispatch:\n {4}inputs:\n {6}runner:\n(?: {8}.+\n)*? {8}default: ""\n/u);
  assert.match(workflow, /\n {6}runner_small:\n(?: {8}.+\n)*? {8}default: ""\n/u);
});
