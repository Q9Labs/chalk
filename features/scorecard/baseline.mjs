import { METRICS, WHOLE_CYCLE } from "./schema.mjs";

// The baseline is the latest master run, so it can carry a metric this tree has retired.
// History keeps its old ids; the diff compares only the ids that exist today.
export function withoutRetiredMetrics(card) {
  return {
    ...card,
    metrics: card.metrics.filter((metric) => Object.hasOwn(METRICS, metric.id)),
    dropped: card.dropped.filter((drop) => drop.metric === WHOLE_CYCLE || Object.hasOwn(METRICS, drop.metric)),
  };
}
