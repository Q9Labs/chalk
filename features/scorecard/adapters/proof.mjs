/** leaveMedianMetrics maps the Leave proof result (scripts/prod-proof/leave-criteria.mjs): the candidate's median and slowest leave. */
export function leaveMedianMetrics(result) {
  const median = { id: "proof.leave_median_ms", unit: "ms", n: result.candidateSamples, p50: result.candidateMedianMs, p95: result.candidateMaxMs, source: "leave-proof" };
  return { metrics: [median], dropped: [] };
}
