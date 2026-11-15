#!/usr/bin/env node
// Save a cut-scoped budget verdict before history publishing or issue updates can fail.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { gatedActionIds, gatedSampleFloor, latencyRegressionLimits, planeBudgets, readBudgets, validateBudgetEntries } from "./budgets.mjs";
import { diffMetrics, expectedMetricRows, renderExpectedMetrics } from "./diff.mjs";
import { parseHistory } from "./history.mjs";
import { regressions } from "./regression.mjs";
import { parseScorecard } from "./schema.mjs";

// --latency-deferred: the cut's cards carry no latency kit run; the staging latency workflow scores that one against the same budgets.
const args = process.argv.slice(2);
const latencyDeferred = args.includes("--latency-deferred");
const [revision, runId, ...paths] = args.filter((arg) => arg !== "--latency-deferred");
if (!/^[0-9a-f]{40}$/.test(revision ?? "") || !/^\d+$/.test(runId ?? "")) throw new Error("usage: evaluate.mjs <cut-sha> <run-id> [scorecard.json]...");
const file = JSON.parse(execFileSync("git", ["show", `${revision}:perf/budgets.json`], { encoding: "utf8" }));
const { budgets } = file;
// A manual trial runs fewer cycles than the full run (LATENCY_SAMPLES) and is held to the same share of them.
// A cut from before gatedSamples existed has no such key, so its floor comes from the budgets file of the revision running this script.
const sampleSource = file.gatedSamples ? file : JSON.parse(readFileSync("perf/budgets.json", "utf8"));
// The same holds for latencyRegression, read from the budgets file next to this script.
const regressionRule = latencyRegressionLimits(file.latencyRegression ? file : await readBudgets());
const sampleFloor = gatedSampleFloor(sampleSource, process.env.LATENCY_SAMPLES ? Number(process.env.LATENCY_SAMPLES) : undefined);
validateBudgetEntries(budgets);
const metrics = new Set();

// history.jsonl is on the scorecard-history branch, which the record job's full checkout holds. Before the first run there is none, and every metric is still learning.
function readHistoryBranch() {
  const ref = "origin/scorecard-history:history.jsonl";
  if (spawnSync("git", ["cat-file", "-e", ref]).status !== 0) return [];
  return parseHistory(execFileSync("git", ["show", ref], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
}

// A gated metric whose p95 is far above the median of the recent passing records of its plane and runner is a gated breach, named like any other.
function scoreRegressions(card) {
  const { failures, learning } = regressions(readHistoryBranch(), card, budgets, gatedSampleFloor(sampleSource), regressionRule);
  const lines = failures.map((row) => `| ${row.id} | ${Math.round(row.p95)} ms | ${Math.round(row.median)} ms (${row.runs} records) | +${Math.round((100 * (row.p95 - row.median)) / row.median)}% |`);
  if (lines.length === 0 && learning.length === 0) return;
  const note = learning.length ? `\n${learning.length} gated metric(s) have too few prior records to judge and only warn.\n` : "";
  const table = lines.length ? `Regression against the median p95 of the last passing records:\n\n| Metric | p95 | Median | Over |\n|---|---|---|---|\n${lines.join("\n")}\n` : "";
  process.stderr.write(`${table}${note}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}${note}\n`);
  for (const row of failures) metrics.add(`${card.mediaPlane}.${row.id} (regression)`);
}
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
  if (!latencyDeferred) scoreRegressions(card);
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
