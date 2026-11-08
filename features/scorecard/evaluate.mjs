#!/usr/bin/env node
// Save a cut-scoped budget verdict before history publishing or issue updates can fail.
import { appendFileSync, readFileSync } from "node:fs";
import { planeBudgets, readBudgets, validateBudgetEntries } from "./budgets.mjs";
import { diffMetrics } from "./diff.mjs";
import { parseScorecard } from "./schema.mjs";

const [revision, runId, ...paths] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(revision ?? "") || !/^\d+$/.test(runId ?? "") || paths.length === 0) throw new Error("usage: evaluate.mjs <cut-sha> <run-id> <scorecard.json>...");
const { budgets } = await readBudgets();
validateBudgetEntries(budgets);
const metrics = new Set();
for (const path of paths) {
  const card = parseScorecard(JSON.parse(readFileSync(path, "utf8")));
  if (card.run.commit !== revision || card.run.tier !== "nightly") throw new Error(`${path}: scorecard is not for nightly SHA ${revision}`);
  if (card.contention?.contended === true) throw new Error(`${path}: contended measurement is not promotion evidence`);
  if (card.metrics.length === 0) throw new Error(`${path}: scorecard has no metrics`);
  for (const row of diffMetrics([], card.metrics, planeBudgets(budgets, card.mediaPlane)).failures) metrics.add(`${card.mediaPlane}.${row.id}`);
}
const verdict = { target_sha: revision, run_id: runId, result: metrics.size ? "gated-breach" : "passed", gated_metrics: [...metrics].sort() };
const json = JSON.stringify(verdict);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${json}\n`);
console.log(json);
if (metrics.size) process.exitCode = 1;
