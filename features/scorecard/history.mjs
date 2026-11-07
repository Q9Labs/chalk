// Nightly history: history.jsonl holds one scorecard per line, on the orphan branch `scorecard-history`.
// The file is append-only, and appending the same run twice changes nothing, so a retry after a crash ends in the same state.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { percentile } from "./stats.mjs";

const BASELINE_RUNS = 7;
const TREND_RUNS = 14;
const key = (card) => `${card.run.id}/${card.mediaPlane}`;

export function readHistory(directory) {
  const file = join(directory, "history.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** appendCards adds the cards that history lacks, one line each, and returns how many it added. */
export function appendCards(directory, cards) {
  const known = new Set(readHistory(directory).map(key));
  const fresh = cards.filter((card) => !known.has(key(card)));
  if (fresh.length > 0) appendFileSync(join(directory, "history.jsonl"), fresh.map((card) => `${JSON.stringify(card)}\n`).join(""));
  return fresh.length;
}

const nightlyOf = (history, plane) => history.filter((card) => card.run.tier === "nightly" && card.mediaPlane === plane);

/**
 * baselineCard is the real-node baseline: the median over the last 7 nightly cards of a plane, per metric.
 * It is a card of the latest of those runs with the medians as its values, so `diff` reads it like any other.
 * Returns undefined when history has no nightly card for the plane.
 */
export function baselineCard(history, plane) {
  const runs = nightlyOf(history, plane).slice(-BASELINE_RUNS);
  if (runs.length === 0) return undefined;
  const byId = new Map();
  for (const card of runs) for (const metric of card.metrics) if (metric.n > 0) byId.set(metric.id, [...(byId.get(metric.id) ?? []), metric]);
  const metrics = [...byId.values()].map((list) => ({
    ...list.at(-1),
    n: list.reduce((sum, metric) => sum + metric.n, 0),
    p50: percentile(
      list.map((metric) => metric.p50),
      0.5,
    ),
    p95: percentile(
      list.map((metric) => metric.p95),
      0.5,
    ),
  }));
  const latest = runs.at(-1);
  return { ...latest, run: { ...latest.run, id: `median-of-${runs.length}` }, metrics, dropped: [] };
}

const number = (value) => String(Math.abs(value) >= 100 ? Math.round(value) : Number(value.toPrecision(3)));

/** trendsMarkdown lists, for every metric, its last 14 nightly values (p95 when the metric has a p95 budget, else p50). */
export function trendsMarkdown(history, budgets) {
  const lines = ["# Nightly trends", "", `The last ${TREND_RUNS} nightly values of every metric, oldest first. A metric with a p95 budget shows its p95; the others show their p50.`, ""];
  for (const plane of [...new Set(history.map((card) => card.mediaPlane))].sort()) {
    const runs = nightlyOf(history, plane).slice(-TREND_RUNS);
    if (runs.length === 0) continue;
    const ids = [...new Set(runs.flatMap((card) => card.metrics.map((metric) => metric.id)))].sort();
    lines.push(`## ${plane}`, "", `${runs.length} runs, ${runs[0].run.startedAt.slice(0, 10)} to ${runs.at(-1).run.startedAt.slice(0, 10)}.`, "", "| Metric | Unit | Values |", "|---|---|---|");
    for (const id of ids) {
      const values = runs.map((card) => {
        const metric = card.metrics.find((candidate) => candidate.id === id);
        if (!metric || metric.n === 0) return "–";
        return number(budgets[id]?.max_p95 !== undefined ? metric.p95 : metric.p50);
      });
      lines.push(`| \`${id}\` | ${runs.at(-1).metrics.find((metric) => metric.id === id)?.unit ?? ""} | ${values.join(" ")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function writeTrends(directory, budgets) {
  writeFileSync(join(directory, "TRENDS.md"), trendsMarkdown(readHistory(directory), budgets));
}
