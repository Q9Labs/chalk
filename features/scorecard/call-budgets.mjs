// The call performance check thinks in devices and scenarios, and perf/budgets.json in metric ids.
// loadCallBudgets converts the file for the check, withCallLimits converts a measured baseline back for propose-call-budgets.
import { validateBudgetEntries } from "./budgets.mjs";
import { CALL_METRICS, ROUTE_METRICS, callMetricId, routeMetricId } from "./metrics.mjs";

const CALL_SEGMENTS = Object.fromEntries(Object.entries(CALL_METRICS).map(([metric, { segment }]) => [metric, segment]));

/**
 * loadCallBudgets returns the file as the call performance check reads it: run settings,
 * the route limits, and one explicit limit per device, scenario and metric. The default limit
 * of a metric is the highest scenario limit, which only a run that records a baseline uses.
 * warnOnly lists the limits whose entry has gate false, as "route/<metric>" and "<device>/<scenario>/<metric>".
 */
export function loadCallBudgets(file) {
  validateBudgetEntries(file.budgets);
  const { baselineCommit, repeats, sampleMs, devices, leaks } = file.callRun;
  const scenarios = {};
  const warnOnly = [];
  for (const device of Object.keys(devices)) {
    scenarios[device] = {};
    for (const [metric, segment] of Object.entries(CALL_SEGMENTS)) {
      const prefix = `web.${device}.`;
      const suffix = `.${segment}`;
      for (const [id, entry] of Object.entries(file.budgets)) {
        if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue;
        const scenario = id.slice(prefix.length, id.length - suffix.length);
        (scenarios[device][scenario] ??= {})[metric] = entry.max_p50;
        if (!entry.gate) warnOnly.push(`${device}/${scenario}/${metric}`);
      }
    }
  }
  const limits = Object.fromEntries(Object.keys(ROUTE_METRICS).map((metric) => [metric, file.budgets[routeMetricId(metric)]?.max_p50]));
  for (const metric of Object.keys(ROUTE_METRICS)) if (!file.budgets[routeMetricId(metric)]?.gate) warnOnly.push(`route/${metric}`);
  for (const metric of Object.keys(CALL_METRICS)) {
    limits[metric] = Math.max(...Object.values(scenarios).flatMap((device) => Object.values(device).map((scenario) => scenario[metric] ?? 0)));
  }
  return { baselineCommit, repeats, sampleMs, devices, leaks, limits, scenarios, warnOnly };
}

/** withCallLimits returns a copy of the file whose call-run limits come from a measured baseline. Other entries keep every field. */
export function withCallLimits(file, { scenarios, route }) {
  const previous = file.budgets;
  const budgets = Object.fromEntries(Object.entries(previous).filter(([id]) => !isCallRunId(id)));
  const entry = (id, limit, tolerancePct) => ({ ...previous[id], max_p50: limit, tolerancePct: previous[id]?.tolerancePct ?? tolerancePct, gate: previous[id]?.gate ?? true });
  for (const [metric, limit] of Object.entries(route)) budgets[routeMetricId(metric)] = entry(routeMetricId(metric), limit, 1);
  for (const [device, byScenario] of Object.entries(scenarios)) {
    for (const [scenario, limits] of Object.entries(byScenario)) {
      for (const [metric, limit] of Object.entries(limits)) {
        const id = callMetricId(device, scenario, metric);
        budgets[id] = entry(id, limit, metric.endsWith("GzipKiB") ? 1 : 10);
      }
    }
  }
  return { ...file, budgets };
}

// A call run owns the web.* ids that end in one of its segments (the route bundle ids end in the same ones); other web.* entries belong to other kits.
function isCallRunId(id) {
  return id.startsWith("web.") && Object.values(CALL_SEGMENTS).some((segment) => id.endsWith(`.${segment}`));
}
