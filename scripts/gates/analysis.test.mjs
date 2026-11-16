import assert from "node:assert/strict";
import test from "node:test";
import { rises } from "./analysis.mjs";
import { baselineIncreases, readBaselineAt } from "./baseline-guard.mjs";

test("a Go function over the limit that the baseline does not name, or a named one that got worse, is reported", () => {
  const baseline = { "apps/api/a.go F": 20 };
  assert.deepEqual(rises("complexity", baseline, { "apps/api/a.go F": 20 }), []);
  assert.equal(rises("complexity", baseline, { "apps/api/a.go F": 21 }).length, 1);
  assert.equal(rises("complexity", baseline, { "apps/api/b.go G": 16 }).length, 1);
});

test("TypeScript offenders compare per file, so moving a function does not fail but a new or worse one does", () => {
  const baseline = { "a.mjs": [30, 18] };
  assert.deepEqual(rises("complexity", baseline, { "a.mjs": [30, 16] }), []);
  assert.equal(rises("complexity", baseline, { "a.mjs": [30, 18, 16] }).length, 1);
  assert.equal(rises("complexity", baseline, { "a.mjs": [31, 18] }).length, 1);
  assert.equal(rises("complexity", baseline, { "b.mjs": [16] }).length, 1);
});

test("an unreachable function or a higher clone count is reported", () => {
  assert.equal(rises("dead-code", { "m/a.go F": true }, { "m/a.go F": true, "m/a.go G": true }).length, 1);
  assert.deepEqual(rises("dead-code", { "m/a.go F": true }, {}), []);
  assert.equal(rises("duplication", 71, 72).length, 1);
  assert.deepEqual(rises("duplication", 71, 70), []);
});


test("analysis baselines reject added or raised allowances and permit only decreases", () => {
  assert.deepEqual(baselineIncreases({ go: { F: 18 }, ts: { "a.ts": [20, 16] }, clones: 40 }, { go: { F: 17 }, ts: { "a.ts": [19] }, clones: 39 }), []);
  assert.equal(baselineIncreases({ go: { F: 18 }, ts: { "a.ts": [20] }, clones: 40 }, { go: { F: 19 }, ts: { "a.ts": [20, 16] }, clones: 40 }).length, 2);
  assert.equal(baselineIncreases({ dead: { "a.go F": true } }, { dead: { "a.go F": true, "b.go G": true } }).length, 1);
  assert.equal(baselineIncreases({ dead: { "a.go F": true } }, { dead: { "a.go F": false } }).length, 1);
});


test("baseline comparison fails closed when the merge-base file cannot be read", () => {
  assert.throws(() => readBaselineAt("refs/heads/does-not-exist", "scripts/gates/analysis-baseline.json"), /fails closed/);
});
