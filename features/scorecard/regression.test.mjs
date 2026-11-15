import assert from "node:assert/strict";
import { test } from "node:test";
import { latencyRegressionLimits, readBudgets } from "./budgets.mjs";
import { regressions } from "./regression.mjs";

const ID = "action.leave_ms";
const budgets = { [ID]: { max_p95: 5000, gate: true } };
const FLOOR = 48;
const RULE = { runs: 7, minRuns: 3, pct: 50, ms: 200 };

let runs = 0;
const card = (p95, { n = 60, plane = "chalk_sfu", size = "ubuntu-24-04", contended = false, id = ID, extra = [] } = {}) => ({
  mediaPlane: plane,
  run: { id: String(++runs), client: { region: "github-hosted", size } },
  contention: contended ? { contended: true } : undefined,
  metrics: [{ id, unit: "ms", n, p50: p95 / 2, p95 }, ...extra],
});
const history = (...p95s) => p95s.map((p95) => card(p95));
const failed = (past, now, options) => regressions(past, card(now, options), budgets, FLOOR, RULE).failures.map((row) => row.id);

test("a gated metric fails when its p95 is more than 50% and more than 200 ms over the median of the prior records", () => {
  assert.deepEqual(failed(history(1000, 1000, 1000), 1600), [ID]);
  assert.deepEqual(failed(history(1000, 1000, 1000), 1500), []);
  assert.deepEqual(failed(history(1000, 1000, 1000), 1200), []);
});

test("a big percentage on a small number of milliseconds does not fail", () => {
  assert.deepEqual(failed(history(200, 200, 200), 380), []);
});

test("fewer than 3 prior records only warn", () => {
  const result = regressions(history(1000, 1000), card(3000), budgets, FLOOR, RULE);
  assert.deepEqual(result, { failures: [], learning: [ID] });
});

test("the median is taken over the last 7 records", () => {
  assert.deepEqual(failed(history(5000, 5000, 5000, 5000, 1000, 1000, 1000, 1000, 1000, 1000, 1000), 1700), [ID]);
});

test("records of another plane or runner, with too few samples or contended, are not baseline", () => {
  const others = [card(300, { plane: "cf_sfu" }), card(300, { size: "ubuntu-24-04-arm" }), card(300, { n: 47 }), card(300, { contended: true })];
  assert.deepEqual(regressions([...others, ...others, ...others], card(3000), budgets, FLOOR, RULE), { failures: [], learning: [ID] });
});

test("a record over its budget, or one the rule itself would fail, never becomes a baseline", () => {
  const over = history(9000, 9000, 9000);
  assert.deepEqual(
    regressions([...history(1000, 1000, 1000), ...over], card(1700), budgets, FLOOR, RULE).failures.map((row) => row.id),
    [ID],
  );
  const slow = history(1000, 1000, 1000, 1700, 1700, 1700, 1700);
  assert.deepEqual(failed(slow, 1700), [ID]);
});

test("a record that lacks samples of another gated action is not a baseline", () => {
  const OTHER = "action.unpublish.audio_removed_ms";
  const both = { ...budgets, [OTHER]: { max_p95: 5000, gate: true } };
  const thin = (p95) => card(p95, { extra: [{ id: OTHER, unit: "ms", n: 0, p50: 0, p95: 0 }] });
  const whole = (p95) => card(p95, { extra: [{ id: OTHER, unit: "ms", n: 60, p50: 100, p95: 200 }] });
  const judged = (past) => regressions(past, whole(1700), both, FLOOR, RULE);
  assert.deepEqual(judged([thin(1000), thin(1000), thin(1000)]), { failures: [], learning: [ID, OTHER] });
  assert.deepEqual(
    judged([thin(1000), whole(1000), whole(1000), whole(1000)]).failures.map((row) => row.id),
    [ID],
  );
});

// The p95 of action.join.first_audio_ms in the nightly records of 13 to 15 Nov 2026 on the GitHub-hosted runner, and the last one (3b5d5a92), which the rule blocks.
test("the observed join.first_audio_ms of 15 Nov 06:11 is a regression against the records before it", () => {
  const id = "action.join.first_audio_ms";
  const past = [1998, 2313, 2368, 1865, 2335, 2402, 1750, 1778, 2390].map((p95) => card(p95, { id }));
  const result = regressions(past, card(4089, { id }), { [id]: { max_p95: 5000, gate: true } }, FLOOR, RULE);
  assert.deepEqual(result.failures, [{ id, p95: 4089, median: 2335, runs: 7 }]);
});

test("the rule lives in perf/budgets.json and a malformed one is refused", async () => {
  assert.deepEqual(latencyRegressionLimits(await readBudgets()), RULE);
  assert.throws(() => latencyRegressionLimits({}), /latencyRegression/);
  assert.throws(() => latencyRegressionLimits({ latencyRegression: { ...RULE, minRuns: 8 } }), /latencyRegression/);
  for (const bad of [{ ms: "200" }, { pct: Infinity }, { ms: 0 }]) assert.throws(() => latencyRegressionLimits({ latencyRegression: { ...RULE, ...bad } }), /latencyRegression/);
});
