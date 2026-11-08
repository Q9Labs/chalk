import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { planeBudgets } from "./budgets.mjs";
import { diffMetrics, renderTable } from "./diff.mjs";
import { trendsMarkdown } from "./history.mjs";
import { METRICS, SCORECARD_SCHEMA } from "./schema.mjs";

const file = JSON.parse(readFileSync(new URL("../../perf/budgets.json", import.meta.url), "utf8"));
const limits = planeBudgets(file.budgets, "chalk_sfu");
const ownSfuIds = Object.keys(limits).filter((id) => id.startsWith("action.") || id.startsWith("sfu.") || id.startsWith("proof."));

// A card in which every own-SFU metric is over its limit: 10% and 1 above a ceiling, half a point under a floor.
const overBudget = ownSfuIds.map((id) => {
  const entry = limits[id];
  const ceiling = entry.max_p95 ?? entry.max_p50;
  const value = ceiling !== undefined ? ceiling * 1.1 + 1 : entry.min_p50 - 0.5;
  return { id, unit: METRICS[id].unit, n: 20, p50: value, p95: value, source: "test" };
});

test("the own SFU gates its action latencies, and the Cloudflare ones only warn", () => {
  const actions = Object.keys(file.budgets).filter((id) => /^(chalk_sfu|cf_sfu)\.action\./.test(id));
  assert.equal(actions.length, 36);
  for (const id of actions) assert.equal(file.budgets[id].gate, id.startsWith("chalk_sfu."), id);
});

test("the delta table lists every own-SFU budget key, and only a gated action latency blocks", () => {
  const diff = diffMetrics([], overBudget, limits);
  const table = renderTable(diff, { title: "t", baselineLabel: "none" });
  for (const id of ownSfuIds) assert.ok(table.includes(`\`${id}\``), `${id} is missing from the delta table`);
  assert.deepEqual(diff.failures.map((row) => row.id).sort(), ownSfuIds.filter((id) => limits[id].gate).sort());
  for (const id of ["sfu.loss_pct", "sfu.stalls_per_class_hour", "sfu.admission_refusals", "proof.join_startup.retry_ms", "proof.join_startup.lossy_stalled_ms"]) {
    assert.match(table, new RegExp(`\`${id}\`.*warns`), `${id} should warn`);
  }
  assert.match(table, /`action\.leave_ms`.*blocks/);
});

test("the nightly trends list every own-SFU budget key with a p95 where the budget bounds the p95", () => {
  const card = { schema: SCORECARD_SCHEMA, run: { id: "run-1", tier: "nightly", startedAt: "2026-11-08T03:00:00.000Z" }, mediaPlane: "chalk_sfu", metrics: overBudget, dropped: [] };
  const table = trendsMarkdown([card], file.budgets);
  for (const id of ownSfuIds) assert.ok(table.includes(`| \`${id}\` |`), `${id} is missing from the trends`);
});
