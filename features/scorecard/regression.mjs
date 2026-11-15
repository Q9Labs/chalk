// The regression rule of the latency verdict: a gated metric fails when its p95 is both more than `pct` percent and more than `ms` milliseconds above the median p95
// of the last `runs` passing records of the same plane and runner type (the limits are latencyRegression in perf/budgets.json).
// Fewer than `minRuns` such records is "learning": the metric warns and never blocks.
import { gatedActionIds, planeBudgets } from "./budgets.mjs";
import { diffMetrics, expectedMetricRows } from "./diff.mjs";
import { countsAsEvidence } from "./schema.mjs";
import { percentile } from "./stats.mjs";

const runnerOf = (card) => `${card.run.client?.region}/${card.run.client?.size}`;

/** p95Of is the p95 of a millisecond metric that has at least `floor` samples, or undefined. */
function p95Of(card, id, floor) {
  const metric = card.metrics.find((candidate) => candidate.id === id);
  return metric && metric.n >= floor && metric.unit === "ms" ? metric.p95 : undefined;
}

function judge(trusted, card, limits, floor, rule) {
  const failures = [];
  const learning = [];
  for (const { id } of card.metrics.filter((metric) => limits[metric.id]?.gate === true)) {
    const p95 = p95Of(card, id, floor);
    if (p95 === undefined) continue;
    const before = trusted
      .map((prior) => p95Of(prior, id, floor))
      .filter((value) => value !== undefined)
      .slice(-rule.runs);
    if (before.length < rule.minRuns) learning.push(id);
    else {
      const median = percentile(before, 0.5);
      if (p95 > median * (1 + rule.pct / 100) && p95 > median + rule.ms) failures.push({ id, p95, median, runs: before.length });
    }
  }
  return { failures, learning };
}

/**
 * regressions scores `card` against the cards of `history` that came before it, oldest first.
 * A passing record is evidence, measured every gated action with enough samples, inside every gated budget, and not itself a regression: a cut the rule blocked never becomes a baseline.
 * @param {{ runs: number, minRuns: number, pct: number, ms: number }} rule  The file's latencyRegression.
 * @returns {{ failures: {id: string, p95: number, median: number, runs: number}[], learning: string[] }}
 */
export function regressions(history, card, budgets, floor, rule) {
  const limits = planeBudgets(budgets, card.mediaPlane);
  const trusted = [];
  for (const prior of history) {
    if (prior.run.id === card.run.id || prior.mediaPlane !== card.mediaPlane || runnerOf(prior) !== runnerOf(card) || !countsAsEvidence(prior)) continue;
    const complete = expectedMetricRows(gatedActionIds(budgets, prior.mediaPlane), prior.metrics, limits, floor, [], prior.dropped).every((row) => row.verdict === "ok");
    if (!complete || diffMetrics([], prior.metrics, limits).failures.length > 0 || judge(trusted, prior, limits, floor, rule).failures.length > 0) continue;
    trusted.push(prior);
  }
  return judge(trusted, card, limits, floor, rule);
}
