import assert from "node:assert/strict";
import test from "node:test";
import { budgetFailures, budgetWarnings, percentile, summarize } from "./latency-stats.mjs";

test("percentile takes the nearest rank", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(twenty, 0.5), 10);
  assert.equal(percentile(twenty, 0.95), 19);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([], 0.5), null);
});

test("summarize keeps timeouts out of the percentiles and counts them", () => {
  const summary = summarize([{ join: 300, leave: 90 }, { join: 100, leave: null }, { join: 200 }]);
  assert.deepEqual(summary.join, { n: 3, timeouts: 0, p50: 200, p95: 300, max: 300 });
  assert.deepEqual(summary.leave, { n: 1, timeouts: 1, p50: 90, p95: 90, max: 90 });
});

test("a budget fails on a slow p95, a timeout, or too few samples", () => {
  const summary = summarize([
    { fast: 10, slow: 900, lost: null, rare: 5 },
    { fast: 20, slow: 950, lost: 10 },
  ]);
  const budgets = { fast: { p95Ms: 50 }, slow: { p95Ms: 500 }, lost: { p95Ms: 500 }, rare: { p95Ms: 50 }, absent: { p95Ms: 50 } };
  assert.deepEqual(budgetFailures(summary, budgets, 2), ["slow: p95 950 ms is over 500 ms", "lost: 1 timed out", "rare: 1 samples, need 2", "absent: 0 samples, need 2"]);
});

test("a warn-only limit warns on its p95 but a timeout or too few samples still fail", () => {
  const summary = summarize([
    { slow: 950, lost: 100, rare: 100 },
    { slow: 900, lost: null },
  ]);
  const budgets = { slow: { p95Ms: 500, warnOnly: true }, lost: { p95Ms: 500, warnOnly: true }, rare: { p95Ms: 500, warnOnly: true } };
  assert.deepEqual(budgetFailures(summary, budgets, 2), ["lost: 1 timed out", "rare: 1 samples, need 2"]);
  assert.deepEqual(budgetWarnings(summary, budgets), ["slow: p95 950 ms is over 500 ms"]);
});
