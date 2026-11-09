// The two files one latency plane writes: the scorecard, built only from the gated metric ids, and the diagnostics sidecar.
import { DIAGNOSTICS_SCHEMA } from "../../features/scorecard/diagnostics.mjs";
import { METRICS, SCORECARD_SCHEMA, WHOLE_CYCLE, parseScorecard } from "../../features/scorecard/schema.mjs";
import { diagnosticsOf } from "./latency-stages.mjs";

// scorecard is the public view of one plane: percentiles per metric id, and what was dropped and why.
export function scorecard(report, plane, run) {
  const { summary } = report.planes[plane];
  const kept = report.cycles.filter((cycle) => cycle.plane === plane && !cycle.dropped);
  const drops = new Map();
  for (const outcome of report.cycles.filter((cycle) => cycle.plane === plane && cycle.dropped)) {
    drops.set(`${WHOLE_CYCLE} ${outcome.dropped}`, (drops.get(`${WHOLE_CYCLE} ${outcome.dropped}`) ?? 0) + 1);
  }
  for (const [metric, { timeouts }] of Object.entries(summary)) if (timeouts) drops.set(`${metric} timeout`, timeouts);
  return parseScorecard({
    schema: SCORECARD_SCHEMA,
    run,
    mediaPlane: plane,
    metrics: Object.keys(METRICS)
      .filter((id) => summary[id])
      .map((id) => ({ id, unit: METRICS[id].unit, n: summary[id].n, p50: summary[id].p50, p95: summary[id].p95, source: "latency-kit" })),
    series: kept.map((cycle, index) => ({
      cycle: index + 1,
      timestamp: cycle.timestamp,
      actions: Object.fromEntries(
        Object.keys(METRICS)
          .filter((id) => id.startsWith("action."))
          .map((id) => [id, cycle.sample[id] ?? null]),
      ),
    })),
    dropped: [...drops].map(([key, count]) => {
      const [metric, reason] = key.split(" ");
      return { metric, reason, count };
    }),
  });
}

// diagnosticsFile is the sidecar of one plane: the round trips and stage timings of each kept cycle, and their percentiles. It stays
// out of the scorecard so every reader of the card sees the card it always saw; only the run summary reads this file.
export function diagnosticsFile(report, plane) {
  const kept = report.cycles.filter((cycle) => cycle.plane === plane && !cycle.dropped);
  const summary = diagnosticsOf(kept);
  if (!summary) return undefined;
  return { schema: DIAGNOSTICS_SCHEMA, plane, cycles: kept.map((cycle, index) => ({ cycle: index + 1, timestamp: cycle.timestamp, ...cycle.trace })), summary };
}
