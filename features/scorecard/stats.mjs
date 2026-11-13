// Number helpers with no dependencies, shared by the scorecard, the production proofs and the web call check.

/** percentile is the nearest-rank percentile of unsorted values, or null when there are none. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

/** formatNumber keeps three significant digits below 100 and whole numbers above; a missing value is a dash. */
export function formatNumber(value) {
  if (value === undefined || value === null) return "–";
  return String(Math.abs(value) >= 100 ? Math.round(value) : Number(value.toPrecision(3)));
}

/** limitText writes a budget's limits for a table cell, or "none" when the metric has no budget. */
export function limitText(budget) {
  if (!budget) return "none";
  const parts = [];
  if (budget.max_p50 !== undefined) parts.push(`p50 ≤ ${formatNumber(budget.max_p50)}`);
  if (budget.max_p95 !== undefined) parts.push(`p95 ≤ ${formatNumber(budget.max_p95)}`);
  if (budget.min_p50 !== undefined) parts.push(`p50 ≥ ${formatNumber(budget.min_p50)}`);
  return parts.join(", ");
}
