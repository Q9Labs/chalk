// perf/budgets.json is the one budget file. Each entry is keyed by scorecard metric id.
// The call performance check still thinks in devices and scenarios, so this module converts
// between the two views: loadCallBudgets for the check, withCallLimits for propose-call-budgets.
import { readFile } from "node:fs/promises";

const BUDGETS_FILE = new URL("../../perf/budgets.json", import.meta.url);

// The check's metric names, each with the scorecard id segment it becomes.
const CALL_METRICS = {
  videoDroppedFramePercent: "video_dropped_frame_pct",
  layoutShift: "layout_shift",
  frameP95Ms: "frame_p95_ms",
  droppedFramePercent: "dropped_frame_pct",
  longTasks: "long_tasks",
  blockingMs: "blocking_ms",
  interactionMs: "interaction_ms",
  heapMiB: "heap_mib",
  domNodes: "dom_nodes",
  firstCallMs: "first_call_ms",
  jsGzipKiB: "js_gzip_kib",
  cssGzipKiB: "css_gzip_kib",
};
const ROUTE_METRICS = { routeJsGzipKiB: "js_gzip_kib", routeCssGzipKiB: "css_gzip_kib" };

const callMetricId = (device, scenario, metric) => `web.${device}.${scenario}.${CALL_METRICS[metric]}`;
const routeMetricId = (metric) => `web.route.${ROUTE_METRICS[metric]}`;

export async function readBudgets() {
  return JSON.parse(await readFile(BUDGETS_FILE, "utf8"));
}

/**
 * validateBudgetEntries checks every entry of the file's budgets object.
 * An entry bounds the median, the p95, or both; real-node metrics start with gate false.
 */
export function validateBudgetEntries(entries) {
  for (const [id, entry] of Object.entries(entries)) {
    if (!/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/.test(id)) throw new Error(`Budget id is not a dotted metric id: ${id}`);
    const limits = [entry.max_p50, entry.max_p95].filter((value) => value !== undefined);
    if (limits.length === 0 || limits.some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`${id}: needs max_p50 or max_p95, a non-negative number`);
    if (!Number.isFinite(entry.tolerancePct) || entry.tolerancePct < 0) throw new Error(`${id}: tolerancePct must be a non-negative number`);
    if (typeof entry.gate !== "boolean") throw new Error(`${id}: gate must be true or false`);
  }
}

/**
 * loadCallBudgets returns the file as the call performance check reads it: run settings,
 * the route limits, and one explicit limit per device, scenario and metric. The default limit
 * of a metric is the highest scenario limit, which only a run that records a baseline uses.
 */
export function loadCallBudgets(file) {
  validateBudgetEntries(file.budgets);
  const { baselineCommit, repeats, sampleMs, devices, leaks } = file.callRun;
  const scenarios = {};
  for (const device of Object.keys(devices)) {
    scenarios[device] = {};
    for (const [metric, segment] of Object.entries(CALL_METRICS)) {
      const prefix = `web.${device}.`;
      const suffix = `.${segment}`;
      for (const [id, entry] of Object.entries(file.budgets)) {
        if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue;
        const scenario = id.slice(prefix.length, id.length - suffix.length);
        (scenarios[device][scenario] ??= {})[metric] = entry.max_p50;
      }
    }
  }
  const limits = Object.fromEntries(Object.entries(ROUTE_METRICS).map(([metric]) => [metric, file.budgets[routeMetricId(metric)]?.max_p50]));
  for (const metric of Object.keys(CALL_METRICS)) {
    limits[metric] = Math.max(...Object.values(scenarios).flatMap((device) => Object.values(device).map((scenario) => scenario[metric] ?? 0)));
  }
  return { baselineCommit, repeats, sampleMs, devices, leaks, limits, scenarios };
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
  return id.startsWith("web.") && Object.values(CALL_METRICS).some((segment) => id.endsWith(`.${segment}`));
}
