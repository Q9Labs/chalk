import { METRICS } from "./schema.mjs";

/** percentile is the nearest-rank percentile, the same rule the call performance check uses. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}

/**
 * metric turns raw samples into a scorecard metric. The unit comes from the registry, so an
 * adapter cannot disagree with it. Samples that are not finite numbers are an adapter bug.
 */
export function metric(id, samples, source) {
  if (!METRICS[id]) throw new Error(`Unknown metric id ${id}`);
  if (samples.some((value) => !Number.isFinite(value))) throw new Error(`${id}: a sample is not a finite number`);
  const empty = samples.length === 0;
  return { id, unit: METRICS[id].unit, n: samples.length, p50: empty ? null : percentile(samples, 0.5), p95: empty ? null : percentile(samples, 0.95), source };
}

/** passRate is a pass metric: the share of runs that passed, from 0 to 1. */
export function passMetric(id, outcomes, source) {
  const share = outcomes.length === 0 ? null : outcomes.filter(Boolean).length / outcomes.length;
  return { id, unit: "pass", n: outcomes.length, p50: share, p95: share, source };
}
