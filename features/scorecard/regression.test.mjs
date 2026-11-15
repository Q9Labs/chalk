import assert from "node:assert/strict";
import { test } from "node:test";
import { regressions } from "./regression.mjs";

const ID = "action.leave_ms";
const budgets = { [ID]: { max_p95: 5000, gate: true } };
const FLOOR = 48;

let runs = 0;
const card = (p95, { n = 60, plane = "chalk_sfu", size = "ubuntu-24-04", contended = false } = {}) => ({
  mediaPlane: plane,
  run: { id: String(++runs), client: { region: "github-hosted", size } },
  contention: contended ? { contended: true } : undefined,
  metrics: [{ id: ID, unit: "ms", n, p50: p95 / 2, p95 }],
});
const history = (...p95s) => p95s.map((p95) => card(p95));
const failed = (past, now, options) => regressions(past, card(now, options), budgets, FLOOR).failures.map((row) => row.id);

test("a gated metric fails when its p95 is more than 50% and more than 200 ms over the median of the prior records", () => {
  assert.deepEqual(failed(history(1000, 1000, 1000), 1600), [ID]);
  assert.deepEqual(failed(history(1000, 1000, 1000), 1500), []);
  assert.deepEqual(failed(history(1000, 1000, 1000), 1200), []);
});

test("a big percentage on a small number of milliseconds does not fail", () => {
  assert.deepEqual(failed(history(200, 200, 200), 380), []);
});

test("fewer than 3 prior records only warn", () => {
  const result = regressions(history(1000, 1000), card(3000), budgets, FLOOR);
  assert.deepEqual(result, { failures: [], learning: [ID] });
});

test("the median is taken over the last 7 records", () => {
  assert.deepEqual(failed(history(5000, 5000, 5000, 5000, 1000, 1000, 1000, 1000, 1000, 1000, 1000), 1700), [ID]);
});

test("records of another plane or runner, with too few samples or contended, are not baseline", () => {
  const others = [card(300, { plane: "cf_sfu" }), card(300, { size: "ubuntu-24-04-arm" }), card(300, { n: 47 }), card(300, { contended: true })];
  assert.deepEqual(regressions([...others, ...others, ...others], card(3000), budgets, FLOOR), { failures: [], learning: [ID] });
});

test("a record over its budget, or one the rule itself would fail, never becomes a baseline", () => {
  const over = history(9000, 9000, 9000);
  assert.deepEqual(
    regressions([...history(1000, 1000, 1000), ...over], card(1700), budgets, FLOOR).failures.map((row) => row.id),
    [ID],
  );
  const slow = history(1000, 1000, 1000, 1700, 1700, 1700, 1700);
  assert.deepEqual(failed(slow, 1700), [ID]);
});
