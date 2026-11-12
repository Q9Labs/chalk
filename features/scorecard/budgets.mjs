// perf/budgets.json is the one budget file. Each entry is keyed by scorecard metric id.
// The call performance check still thinks in devices and scenarios, so this module converts
// between the two views: loadCallBudgets for the check, withCallLimits for propose-call-budgets.
import { readFile } from "node:fs/promises";
import { MEDIA_PLANES } from "./schema.mjs";
import { CALL_METRICS, ROUTE_METRICS, callMetricId, routeMetricId } from "./metrics.mjs";

const BUDGETS_FILE = new URL("../../perf/budgets.json", import.meta.url);

const CALL_SEGMENTS = Object.fromEntries(Object.entries(CALL_METRICS).map(([metric, { segment }]) => [metric, segment]));

export async function readBudgets() {
  return JSON.parse(await readFile(BUDGETS_FILE, "utf8"));
}

/**
 * validateBudgetEntries checks every entry of the file's budgets object.
 * An entry bounds the median or the p95 from above (max_*), or the median from below (min_p50, for pass rates).
 * Real-node metrics start with gate false.
 */
export function validateBudgetEntries(entries) {
  for (const [id, entry] of Object.entries(entries)) {
    if (!/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/.test(id)) throw new Error(`Budget id is not a dotted metric id: ${id}`);
    const limits = [entry.max_p50, entry.max_p95, entry.min_p50].filter((value) => value !== undefined);
    if (limits.length === 0 || limits.some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`${id}: needs max_p50, max_p95 or min_p50, a non-negative number`);
    if (!Number.isFinite(entry.tolerancePct) || entry.tolerancePct < 0) throw new Error(`${id}: tolerancePct must be a non-negative number`);
    if (typeof entry.gate !== "boolean") throw new Error(`${id}: gate must be true or false`);
  }
}

/**
 * planeBudgets returns the budgets that apply to one media plane. A limit that differs by plane is keyed by the plane
 * first (chalk_sfu.action.leave_ms) and replaces the plain entry of the same id.
 * @param {Record<string, any>} budgets  The budgets object of perf/budgets.json.
 * @param {string} plane
 */
export function planeBudgets(budgets, plane) {
  const prefix = `${plane}.`;
  const own = Object.entries(budgets)
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, entry]) => [id.slice(prefix.length), entry]);
  const others = Object.entries(budgets).filter(([id]) => !MEDIA_PLANES.some((name) => id.startsWith(`${name}.`)));
  return Object.fromEntries([...others, ...own]);
}

/**
 * gatedActionIds lists the action.* metric ids whose budget for the plane has gate true, as scorecard metric ids.
 * A card for that plane must measure each of them.
 * @param {Record<string, any>} budgets  The budgets object of perf/budgets.json.
 * @param {string} plane
 */
export function gatedActionIds(budgets, plane) {
  return Object.entries(planeBudgets(budgets, plane))
    .filter(([id, entry]) => id.startsWith("action.") && entry.gate === true)
    .map(([id]) => id)
    .sort();
}

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

// planeLimits is the p95 limit of every action metric that has a budget for the plane, in the shape budgetFailures reads.
// A limit whose entry has gate false is warnOnly: going over it warns, but a timeout or too few samples still fails the run.
export function planeLimits(budgets, plane) {
  const entries = Object.entries(planeBudgets(budgets, plane)).filter(([id, entry]) => id.startsWith("action.") && entry.max_p95 !== undefined);
  return Object.fromEntries(entries.map(([id, entry]) => [id, { p95Ms: entry.max_p95, warnOnly: !entry.gate }]));
}
