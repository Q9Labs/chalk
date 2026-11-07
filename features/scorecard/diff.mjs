// Compares a run's metrics with a baseline and the budgets, and renders the delta table.
// ❌ over budget, ⚠️ more than tolerancePct worse than the baseline but within budget, ✅ more than 5% better.
import { WHOLE_CYCLE } from "./schema.mjs";

const BETTER_PCT = 5;
const DEFAULT_TOLERANCE_PCT = 10;

const primary = (metric, budget) => (budget?.max_p95 !== undefined ? metric.p95 : metric.p50);

function overBudget(metric, budget) {
  if (!budget || metric.n === 0) return false;
  return (budget.max_p50 !== undefined && metric.p50 > budget.max_p50) || (budget.max_p95 !== undefined && metric.p95 > budget.max_p95) || (budget.min_p50 !== undefined && metric.p50 < budget.min_p50);
}

/** worsePct is how much worse (positive) or better (negative) the run is than the baseline, in percent. */
function worsePct(unit, before, now) {
  const delta = unit === "pass" ? before - now : now - before;
  if (before === 0) return delta === 0 ? 0 : delta > 0 ? 100 : -100;
  return (100 * delta) / Math.abs(before);
}

/**
 * diffMetrics returns one row per current metric and the ids the baseline had but this run lacks.
 * @param {any[]} baseline  Metrics of the baseline, or [] when there is none.
 * @param {any[]} current
 * @param {Record<string, any>} budgets  The budgets object of perf/budgets.json.
 */
export function diffMetrics(baseline, current, budgets) {
  const before = new Map(baseline.map((metric) => [metric.id, metric]));
  const rows = current.map((metric) => {
    const budget = budgets[metric.id];
    const base = before.get(metric.id);
    const gate = budget?.gate === true;
    const row = { id: metric.id, unit: metric.unit, gate, budget, baseline: base && primary(base, budget), now: primary(metric, budget), changePct: null, status: "same" };
    if (metric.n === 0) return { ...row, status: "empty" };
    if (overBudget(metric, budget)) return { ...row, status: "over" };
    if (!base || base.n === 0) return { ...row, status: "new" };
    row.changePct = worsePct(metric.unit, row.baseline, row.now);
    if (row.changePct > (budget?.tolerancePct ?? DEFAULT_TOLERANCE_PCT)) row.status = "worse";
    else if (row.changePct < -BETTER_PCT) row.status = "better";
    return row;
  });
  const seen = new Set(current.map((metric) => metric.id));
  const missing = baseline.filter((metric) => !seen.has(metric.id)).map((metric) => metric.id);
  return { rows, missing, failures: rows.filter((row) => row.status === "over" && row.gate) };
}

const MARK = { over: "❌", worse: "⚠️", better: "✅" };
const ORDER = ["over", "worse", "better"];

function number(value) {
  if (value === undefined || value === null) return "–";
  return String(Math.abs(value) >= 100 ? Math.round(value) : Number(value.toPrecision(3)));
}

function limitText(budget) {
  if (!budget) return "none";
  const parts = [];
  if (budget.max_p50 !== undefined) parts.push(`p50 ≤ ${number(budget.max_p50)}`);
  if (budget.max_p95 !== undefined) parts.push(`p95 ≤ ${number(budget.max_p95)}`);
  if (budget.min_p50 !== undefined) parts.push(`p50 ≥ ${number(budget.min_p50)}`);
  return parts.join(", ");
}

/** dropSummary lists what the run dropped, as "reason ×count" per metric. */
function dropSummary(dropped) {
  return dropped.map((drop) => `${drop.metric === WHOLE_CYCLE ? "whole cycle" : drop.metric}: ${drop.reason} ×${drop.count}`);
}

/**
 * renderTable writes the delta table in Markdown. Only rows that changed status are listed; the rest are counted.
 * @param {ReturnType<typeof diffMetrics>} diff
 * @param {{ title: string, baselineLabel: string, dropped?: any[] }} options
 */
export function renderTable(diff, { title, baselineLabel, dropped = [] }) {
  const shown = diff.rows.filter((row) => ORDER.includes(row.status)).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Number(b.gate) - Number(a.gate));
  const count = (status) => diff.rows.filter((row) => row.status === status).length;
  const lines = [`### ${title}`, ""];
  const gated = diff.failures.length;
  const warned = count("over") - gated;
  lines.push(`Baseline: ${baselineLabel}. ${gated} over a gated budget, ${warned} over a warn-only budget, ${count("worse")} slower or larger than the baseline, ${count("better")} better.`, "");
  if (shown.length > 0) {
    lines.push("| | Metric | Baseline | Now | Change | Budget | Gate |", "|---|---|---|---|---|---|---|");
    for (const row of shown) {
      const change = row.changePct === null ? "" : `${row.changePct > 0 ? "+" : ""}${number(row.changePct)}%`;
      lines.push(`| ${MARK[row.status]} | \`${row.id}\` | ${number(row.baseline)} | ${number(row.now)} ${row.unit} | ${change} | ${limitText(row.budget)} | ${row.gate ? "blocks" : "warns"} |`);
    }
    lines.push("");
  }
  const rest = [`${count("same")} within tolerance`, `${count("new")} without a baseline`];
  if (count("empty") > 0) rest.push(`${count("empty")} with no samples`);
  lines.push(`${rest.join(", ")}.`);
  if (diff.missing.length > 0)
    lines.push(
      `Missing from this run: ${diff.missing
        .slice(0, 10)
        .map((id) => `\`${id}\``)
        .join(", ")}${diff.missing.length > 10 ? `, and ${diff.missing.length - 10} more` : ""}.`,
    );
  const drops = dropSummary(dropped);
  if (drops.length > 0) lines.push(`Dropped: ${drops.join("; ")}.`);
  return `${lines.join("\n")}\n`;
}
