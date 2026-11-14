#!/usr/bin/env node
// Collect the own-SFU latency scorecard of a nightly run: copy it to the artifact folder and list every metric against its budget in the run summary.
// An absent or empty card fails, so a run that measured nothing cannot pass for a revision that should have a card.
// Usage: own-sfu.mjs <evidence-dir> <plane> <revision> <artifact-dir>   (run from the repository root; GITHUB_STEP_SUMMARY is optional)
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { planeBudgets, readBudgets } from "./budgets.mjs";
import { WHOLE_CYCLE, countsAsEvidence, parseScorecard } from "./schema.mjs";
import { contentionMarkdown } from "./contention.mjs";
import { diagnosticsFileName, diagnosticsReport } from "./diagnostics.mjs";
import { overBudget } from "./diff.mjs";
import { planeNoteMarkdown } from "./plane-note.mjs";
import { limitText } from "./stats.mjs";

const [evidence, plane, revision, artifacts] = process.argv.slice(2);
if (!artifacts) throw new Error("usage: own-sfu.mjs <evidence-dir> <plane> <revision> <artifact-dir>");
const title = `Own SFU nightly: ${plane} at ${revision.slice(0, 9)}`;

function summarize(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function fail(reason) {
  summarize(`### ${title}\n\n${reason}\n`);
  process.exit(1);
}

function findCard(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === `scorecard-${plane}.json`) return join(entry.parentPath, entry.name);
  }
  return undefined;
}

const path = findCard(evidence);
if (!path) fail("The latency run wrote no scorecard.");
const card = parseScorecard(JSON.parse(readFileSync(path, "utf8")));
if (card.metrics.length === 0 && countsAsEvidence(card)) fail("The scorecard has no metrics.");

mkdirSync(artifacts, { recursive: true });
copyFileSync(path, join(artifacts, `scorecard-${plane}.json`));
if (card.contention) summarize(contentionMarkdown(card.contention));
const note = planeNoteMarkdown(card.mediaPlane);
if (note) summarize(note);

const { budgets } = await readBudgets();
const own = planeBudgets(budgets, card.mediaPlane);
const rows = card.metrics.map((metric) => {
  const budget = own[metric.id];
  const status = card.contention?.unobservable ? "⚠️ unavailable" : card.contention?.contended ? "⚠️ diagnostic" : overBudget(metric, budget) ? (budget.gate ? "❌ blocks" : "⚠️ warns") : "✅";
  return `| \`${metric.id}\` | ${metric.n} | ${metric.p50} | ${metric.p95} ${metric.unit} | ${limitText(budget)} | ${status} |`;
});
const drops = card.dropped.map((drop) => `${drop.metric === WHOLE_CYCLE ? "whole cycle" : drop.metric}: ${drop.reason} ×${drop.count}`);
summarize([`### ${title}`, "", `Plane \`${card.mediaPlane}\`, revision \`${card.run.commit}\`, ${card.metrics.length} metrics.`, "", "| Metric | n | p50 | p95 | Budget | |", "|---|---|---|---|---|---|", ...rows, ...(drops.length > 0 ? ["", `Dropped: ${drops.join("; ")}.`] : []), ""].join("\n"));

// The diagnostics sidecar sits next to the card and is read for this summary only. Nothing above or below depends on it.
try {
  const sidecar = join(dirname(path), diagnosticsFileName(plane));
  const sidecarText = existsSync(sidecar) ? readFileSync(sidecar, "utf8") : undefined;
  summarize(diagnosticsReport(sidecarText));
  if (sidecarText !== undefined) copyFileSync(sidecar, join(artifacts, diagnosticsFileName(plane)));
} catch (error) {
  summarize(`Action latency diagnostics: unreadable, not shown (${error instanceof Error ? error.message : String(error)}).\n`);
}
if (!countsAsEvidence(card)) process.exitCode = 1;
