#!/usr/bin/env node
// Save a cut-scoped budget verdict before history publishing or issue updates can fail.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gatedActionIds, gatedSampleFloor, planeBudgets, validateBudgetEntries } from "./budgets.mjs";
import { diffMetrics, expectedMetricRows, renderExpectedMetrics } from "./diff.mjs";
import { parseScorecard } from "./schema.mjs";

// --latency-deferred: the cut's cards carry no latency kit run; the staging latency workflow scores that one against the same budgets.
const args = process.argv.slice(2);
const latencyDeferred = args.includes("--latency-deferred");
const [revision, runId, ...paths] = args.filter((arg) => arg !== "--latency-deferred");
if (!/^[0-9a-f]{40}$/.test(revision ?? "") || !/^\d+$/.test(runId ?? "")) throw new Error("usage: evaluate.mjs <cut-sha> <run-id> [scorecard.json]...");
const file = JSON.parse(execFileSync("git", ["show", `${revision}:perf/budgets.json`], { encoding: "utf8" }));
const { budgets } = file;
// A manual trial runs fewer cycles than the full run (LATENCY_SAMPLES) and is held to the same share of them.
const sampleFloor = gatedSampleFloor(file, process.env.LATENCY_SAMPLES ? Number(process.env.LATENCY_SAMPLES) : undefined);
validateBudgetEntries(budgets);
const metrics = new Set();
const planes = new Set();
const chalkSfuMetrics = [];
const missing = new Set();
for (const path of paths) {
  const card = parseScorecard(JSON.parse(readFileSync(path, "utf8")));
  if (card.run.commit !== revision || card.run.tier !== "nightly") throw new Error(`${path}: scorecard is not for nightly SHA ${revision}`);
  if (card.contention?.contended === true) throw new Error(`${path}: contended measurement is not promotion evidence`);
  if (card.contention?.unobservable === true) {
    missing.add(`${card.mediaPlane} scorecard (unobservable: node metrics unavailable)`);
    continue;
  }
  if (card.metrics.length === 0) throw new Error(`${path}: scorecard has no metrics`);
  planes.add(card.mediaPlane);
  // Only the Chalk SFU plane holds the cut. The Cloudflare plane gates in its own history job.
  if (card.mediaPlane !== "chalk_sfu") continue;
  chalkSfuMetrics.push(...card.metrics);
  for (const row of diffMetrics([], card.metrics, planeBudgets(budgets, card.mediaPlane)).failures) metrics.add(`${card.mediaPlane}.${row.id}`);
}
// A standalone latency evaluation needs the Chalk SFU card: a Cloudflare card cannot replace its measurements, and the latency kit
// records every gated action metric each cycle, so a chalk_sfu metric with no samples across the cards is missing evidence, not a pass.
// A deferred cut has no latency card to show: the cut's proofs write none, and Promote adds the staging latency verdict of the same SHA.
if (planes.has("chalk_sfu")) {
  if (!latencyDeferred) {
    // Every gated action metric must be there with enough samples; the table lists them all, so a missing one is a row.
    const rows = expectedMetricRows(gatedActionIds(budgets, "chalk_sfu"), chalkSfuMetrics, planeBudgets(budgets, "chalk_sfu"), sampleFloor);
    const table = renderExpectedMetrics(rows, `Gated action metrics of ${revision.slice(0, 8)} on chalk_sfu`);
    process.stderr.write(`${table}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
    for (const row of rows) if (row.verdict === "missing" || row.verdict === "too few samples") missing.add(`chalk_sfu.${row.id} (${row.verdict}: ${row.samples} of ${row.floor})`);
  }
} else if (!latencyDeferred && ![...missing].some((item) => item.startsWith("chalk_sfu scorecard"))) {
  missing.add("chalk_sfu scorecard");
}
let result = "passed";
if (missing.size) result = "missing";
else if (metrics.size) result = "gated-breach";
const verdict = { target_sha: revision, run_id: runId, budgets_revision: revision, result, gated_metrics: [...metrics].sort(), missing_items: [...missing].sort() };
const json = JSON.stringify(verdict);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${json}\n`);
console.log(json);
if (verdict.result !== "passed") process.exitCode = 1;
