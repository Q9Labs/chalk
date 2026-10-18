#!/usr/bin/env node
// Produces a reviewable candidate; never changes the checked-in budgets itself.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { METRICS, validateBudgets } from "./call-performance-metrics.mjs";

const { values } = parseArgs({ options: { baseline: { type: "string" }, out: { type: "string" } } });
if (!values.baseline || !values.out) throw new Error("Pass --baseline <report.json> --out <candidate.json>");
const baseline = JSON.parse(await readFile(values.baseline, "utf8"));
const budgets = JSON.parse(await readFile(resolve(import.meta.dirname, "../perf-budgets.json"), "utf8"));
if (baseline.errors.length || baseline.mode !== "full" || baseline.results.length !== 16 || baseline.results.some((result) => result.samples.length < 5)) throw new Error("A candidate needs five complete, successful repetitions of every scenario/device");
if (baseline.baselineCommit !== budgets.baselineCommit) throw new Error("Baseline commit differs from the declared budget baseline");
if (baseline.source !== budgets.baselineCommit) throw new Error("Collect the baseline from the pinned commit, not another revision");
const floors = { frameP95Ms: 5, droppedFramePercent: 2, longTasks: 2, blockingMs: 25, interactionMs: 24, heapMiB: 2, domNodes: 50, firstCallMs: 100 };
budgets.scenarios = {};
for (const result of baseline.results) {
  const limits = {};
  for (const metric of METRICS.filter((metric) => metric !== "firstCallMs" || result.scenario === "first-load")) {
    const measurement = result.summary[metric];
    if (!measurement || !Number.isFinite(measurement.max)) throw new Error(`Missing baseline ${result.device}/${result.scenario}/${metric}`);
    limits[metric] = metric === "droppedFramePercent" ? Math.min(99.5, Math.ceil(Math.max(measurement.median + 3, measurement.max + 2))) : Math.ceil(Math.max(measurement.median * 1.25, measurement.max * 1.15) + (floors[metric] ?? 0));
    if (metric.endsWith("GzipKiB")) limits[metric] = Math.ceil(measurement.max * 1.03);
  }
  (budgets.scenarios[result.device] ??= {})[result.scenario] = limits;
}
for (const metric of ["routeJsGzipKiB", "routeCssGzipKiB"]) budgets.limits[metric] = Math.ceil(baseline.routeBundle[metric] * 1.03);
// Keep default limits consistent; the checker also requires explicit limits for every scenario.
for (const metric of METRICS) budgets.limits[metric] = Math.max(...Object.values(budgets.scenarios).flatMap((scenarios) => Object.values(scenarios).map((limits) => limits[metric] ?? 0)));
validateBudgets(budgets);
await writeFile(values.out, `${JSON.stringify(budgets, null, 2)}\n`);
console.log(`Candidate only: ${values.out}. Review the baseline and commit a deliberate budget update separately.`);
