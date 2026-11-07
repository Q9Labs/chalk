import { CALL_METRICS, ROUTE_METRICS, callMetricId, routeMetricId } from "../metrics.mjs";
import { metric } from "../stats.mjs";

const SOURCE = "check-call-performance";

/**
 * webMetrics maps the report apps/web/scripts/check-call-performance.mjs writes to web.* metrics.
 * A bundle-only run reports every metric the page produced, but its timings come from one unthrottled
 * repeat, so only the bundle sizes are kept then.
 */
export function webMetrics(report) {
  const bundleOnly = report.mode === "bundle-only";
  const metrics = [];
  for (const name of Object.keys(ROUTE_METRICS)) {
    if (report.routeBundle && Number.isFinite(report.routeBundle[name])) metrics.push(metric(routeMetricId(name), [report.routeBundle[name]], SOURCE));
  }
  for (const result of report.results ?? []) {
    for (const name of Object.keys(CALL_METRICS)) {
      if (bundleOnly && !name.endsWith("GzipKiB")) continue;
      if (name === "firstCallMs" && result.scenario !== "first-load") continue;
      const samples = result.samples.map((sample) => sample[name]);
      metrics.push(metric(callMetricId(result.device, result.scenario, name), samples, SOURCE));
    }
  }
  return { metrics, dropped: [] };
}
