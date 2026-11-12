#!/usr/bin/env node
// Save a cut-scoped budget verdict before history publishing or issue updates can fail.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gatedActionIds, planeBudgets, validateBudgetEntries } from "./budgets.mjs";
import { diffMetrics } from "./diff.mjs";
import { parseScorecard } from "./schema.mjs";

// --latency-deferred: the cut's cards carry no latency kit run; the staging latency workflow scores that one against the same budgets.
const args = process.argv.slice(2);
const latencyDeferred = args.includes("--latency-deferred");
const [revision, runId, ...paths] = args.filter((arg) => arg !== "--latency-deferred");
if (!/^[0-9a-f]{40}$/.test(revision ?? "") || !/^\d+$/.test(runId ?? "")) throw new Error("usage: evaluate.mjs <cut-sha> <run-id> [scorecard.json]...");
const { budgets } = JSON.parse(execFileSync("git", ["show", `${revision}:perf/budgets.json`], { encoding: "utf8" }));
validateBudgetEntries(budgets);
const metrics = new Set();
const planes = new Set();
const measured = new Set();
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
  // Only the own-SFU plane holds the cut. The Cloudflare plane gates in its own history job.
  if (card.mediaPlane !== "chalk_sfu") continue;
  for (const metric of card.metrics) if (metric.n > 0) measured.add(metric.id);
  for (const row of diffMetrics([], card.metrics, planeBudgets(budgets, card.mediaPlane)).failures) metrics.add(`${card.mediaPlane}.${row.id}`);
}
// A standalone latency evaluation needs the own-SFU card: a Cloudflare card cannot replace its measurements, and the latency kit
// records every gated action metric each cycle, so a chalk_sfu metric with no samples across the cards is missing evidence, not a pass.
// A deferred cut has no latency card to show: the cut's proofs write none, and Promote adds the staging latency verdict of the same SHA.
if (planes.has("chalk_sfu")) {
  if (!latencyDeferred) for (const id of gatedActionIds(budgets, "chalk_sfu")) if (!measured.has(id)) missing.add(`chalk_sfu.${id}`);
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
