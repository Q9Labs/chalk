// Percentiles and budgets for the action-latency benchmark. A sample is a map of metric to milliseconds,
// or null when the remote never saw the action before the timeout.

// percentile uses the nearest rank, so a p95 of twenty samples is the nineteenth smallest.
export function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length, Math.ceil(fraction * sorted.length)) - 1];
}

export function summarize(samples) {
  const metrics = new Set(samples.flatMap((sample) => Object.keys(sample)));
  const summary = {};
  for (const metric of metrics) {
    const present = samples.map((sample) => sample[metric]).filter((value) => value !== undefined);
    const values = present.filter((value) => value !== null).sort((left, right) => left - right);
    summary[metric] = { n: values.length, timeouts: present.length - values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.at(-1) ?? null };
  }
  return summary;
}

// budgetFailures lists every metric whose p95 is over budget, that timed out, or that has fewer samples than required.
// A budget with warnOnly never fails on its p95; budgetWarnings reports that instead. Timeouts and missing samples fail either way.
export function budgetFailures(summary, budgets, minimumSamples) {
  const failures = [];
  for (const [metric, budget] of Object.entries(budgets)) {
    const observed = summary[metric];
    if (observed?.timeouts) failures.push(`${metric}: ${observed.timeouts} timed out`);
    else if (!observed || observed.n < minimumSamples) failures.push(`${metric}: ${observed?.n ?? 0} samples, need ${minimumSamples}`);
    else if (!budget.warnOnly && observed.p95 > budget.p95Ms) failures.push(`${metric}: p95 ${observed.p95} ms is over ${budget.p95Ms} ms`);
  }
  return failures;
}

// budgetWarnings lists every warn-only metric whose p95 is over its limit.
export function budgetWarnings(summary, budgets) {
  return Object.entries(budgets).flatMap(([metric, budget]) => (budget.warnOnly && summary[metric]?.p95 > budget.p95Ms ? [`${metric}: p95 ${summary[metric].p95} ms is over ${budget.p95Ms} ms`] : []));
}
