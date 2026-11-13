// perf/budgets.json is the one budget file. Each entry is keyed by scorecard metric id.
// call-budgets.mjs converts between this file and the call performance check's view of devices and scenarios.
import { readFile } from "node:fs/promises";
import { MEDIA_PLANES } from "./schema.mjs";

const BUDGETS_FILE = new URL("../../perf/budgets.json", import.meta.url);

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

// planeLimits is the p95 limit of every action metric that has a budget for the plane, in the shape budgetFailures reads.
// A limit whose entry has gate false is warnOnly: going over it warns, but a timeout or too few samples still fails the run.
export function planeLimits(budgets, plane) {
  const entries = Object.entries(planeBudgets(budgets, plane)).filter(([id, entry]) => id.startsWith("action.") && entry.max_p95 !== undefined);
  return Object.fromEntries(entries.map(([id, entry]) => [id, { p95Ms: entry.max_p95, warnOnly: !entry.gate }]));
}
