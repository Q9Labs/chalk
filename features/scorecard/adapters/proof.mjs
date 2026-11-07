import { metric } from "../stats.mjs";

const JOIN_SCENARIOS = { retry: "proof.join_startup.retry_ms", "lossy-stalled": "proof.join_startup.lossy_stalled_ms" };

/**
 * joinStartupMetrics maps results.json of scripts/web-proof/join-startup.mjs: the time a client with the fix
 * takes to reach a live connection. Runs that did not end live are the proof's own failures and are not timed.
 */
export function joinStartupMetrics(results) {
  const source = "join-startup-proof";
  const metrics = Object.entries(JOIN_SCENARIOS).map(([scenario, id]) => {
    const live = results.filter((result) => result.revision === "after" && result.scenario === scenario && result.connection?.status === "live");
    return metric(
      id,
      live.map((result) => result.elapsedMs),
      source,
    );
  });
  return { metrics, dropped: [] };
}

/** leaveMedianMetrics maps the Leave proof result (scripts/prod-proof/leave-criteria.mjs): the candidate's median and slowest leave. */
export function leaveMedianMetrics(result) {
  const median = { id: "proof.leave_median_ms", unit: "ms", n: result.candidateSamples, p50: result.candidateMedianMs, p95: result.candidateMaxMs, source: "leave-proof" };
  return { metrics: [median], dropped: [] };
}
