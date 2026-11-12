#!/usr/bin/env node
// scorecard build: adapters turn existing measurement output into one validated scorecard file.
// scorecard diff:  compares a scorecard with a baseline and prints the delta table.
// scorecard append: adds scorecards to the nightly history. scorecard baseline: the median of the last seven nightly runs.
// scorecard comment: creates or updates one section of the pull request's single scorecard comment.
// scorecard evidence: prints "yes" or "no" for whether a scorecard file counts as evidence (see countsAsEvidence).
// scorecard go-output: prints the human-readable lines of `go test -json` on stdin, so a gate can keep its log.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { planeBudgets, readBudgets, validateBudgetEntries } from "./budgets.mjs";
import { deviceMetrics } from "./adapters/device.mjs";
import { leaveMedianMetrics } from "./adapters/proof.mjs";
import { goTestMetrics, liveSampleMetrics, nodeLoadMetrics } from "./adapters/sfu.mjs";
import { webMetrics } from "./adapters/web.mjs";
import { sectionComment, sectionMarker } from "./comment.mjs";
import { diffMetrics, renderTable } from "./diff.mjs";
import { contentionMarkdown } from "./contention.mjs";
import { planeNoteMarkdown } from "./plane-note.mjs";
import { appendCards, baselineCard, readHistory, writeTrends } from "./history.mjs";
import { SCORECARD_SCHEMA, countsAsEvidence, parseScorecard } from "./schema.mjs";

const read = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(read(path));

// Each input flag names a file in one adapter's format.
const INPUTS = {
  action: (path) => {
    const card = readJson(path);
    return { metrics: card.metrics, dropped: card.dropped };
  },
  web: (path) => webMetrics(readJson(path)),
  "sfu-tests": (path) => goTestMetrics(read(path)),
  "sfu-live": (path) => liveSampleMetrics(read(path)),
  "sfu-load": (path) => nodeLoadMetrics(readJson(path)),
  "proof-leave": (path) => leaveMedianMetrics(readJson(path)),
  device: (path) => deviceMetrics(readJson(path)),
};

function build(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      tier: { type: "string" },
      environment: { type: "string" },
      plane: { type: "string", default: "chalk_sfu" },
      commit: { type: "string", default: process.env.GITHUB_SHA },
      id: { type: "string", default: `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` },
      "client-kind": { type: "string", default: "browser" },
      browser: { type: "string" },
      region: { type: "string" },
      size: { type: "string" },
      ...Object.fromEntries(Object.keys(INPUTS).map((name) => [name, { type: "string" }])),
    },
  });
  const metrics = [];
  const dropped = [];
  for (const [name, adapt] of Object.entries(INPUTS)) {
    if (!values[name]) continue;
    const result = adapt(values[name]);
    metrics.push(...result.metrics);
    dropped.push(...result.dropped);
  }
  const browser = values.browser ?? (values.web ? `chromium/${readJson(values.web).browser}` : "none");
  const card = parseScorecard({
    schema: SCORECARD_SCHEMA,
    run: { id: values.id, commit: values.commit, tier: values.tier, environment: values.environment, startedAt: new Date().toISOString(), client: { kind: values["client-kind"], browser, region: values.region, size: values.size } },
    mediaPlane: values.plane,
    metrics,
    dropped,
  });
  writeFileSync(values.out, `${JSON.stringify(card, null, 2)}\n`);
  console.log(`Wrote ${values.out}: ${metrics.length} metrics, ${dropped.length} drops.`);
}

async function diff(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { baseline: { type: "string" }, current: { type: "string" }, title: { type: "string", default: "Performance scorecard" }, "baseline-label": { type: "string", default: "the latest master run" }, markdown: { type: "string" }, "fail-on-gate": { type: "boolean" } },
  });
  const current = parseScorecard(readJson(values.current));
  const candidate = values.baseline ? parseScorecard(readJson(values.baseline)) : undefined;
  const baseline = candidate && countsAsEvidence(candidate) ? candidate : undefined;
  const { budgets } = await readBudgets();
  validateBudgetEntries(budgets);
  const result = diffMetrics(baseline?.metrics ?? [], current.metrics, planeBudgets(budgets, current.mediaPlane));
  if (!countsAsEvidence(current)) {
    result.failures = [];
    for (const row of result.rows) row.gate = false;
  }
  const table = contentionMarkdown(current.contention) + renderTable(result, { title: values.title, baselineLabel: baseline ? values["baseline-label"] : "none yet", dropped: current.dropped });
  const output = planeNoteMarkdown(current.mediaPlane) + table;
  if (values.markdown) writeFileSync(values.markdown, output);
  console.log(output);
  if (values["fail-on-gate"] && countsAsEvidence(current) && result.failures.length > 0) {
    console.error(`${result.failures.length} metric(s) are over a gated budget: ${result.failures.map((row) => row.id).join(", ")}`);
    process.exitCode = 1;
  }
}

async function comment(argv) {
  const { values } = parseArgs({ args: argv, options: { repo: { type: "string" }, pr: { type: "string" }, section: { type: "string" }, file: { type: "string" } } });
  const gh = (...args) => execFileSync("gh", ["api", ...args], { encoding: "utf8" });
  const existing = JSON.parse(gh(`repos/${values.repo}/issues/${values.pr}/comments`, "--paginate", "--slurp"))
    .flat()
    .find((item) => item.body.startsWith(sectionMarker(values.section)));
  const body = sectionComment(values.section, read(values.file));
  if (existing) gh(`repos/${values.repo}/issues/comments/${existing.id}`, "-X", "PATCH", "-f", `body=${body}`);
  else gh(`repos/${values.repo}/issues/${values.pr}/comments`, "-f", `body=${body}`);
}

// append adds scorecards to <history>/history.jsonl and regenerates TRENDS.md.
async function append(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { history: { type: "string" } } });
  const cards = positionals.map((path) => parseScorecard(readJson(path)));
  const added = appendCards(values.history, cards);
  const { budgets } = await readBudgets();
  writeTrends(values.history, budgets);
  console.log(`Appended ${added} of ${cards.length} scorecards.`);
}

// baseline writes the median of the last seven nightly scorecards of a plane; it writes nothing when history has none.
function baseline(argv) {
  const { values } = parseArgs({ args: argv, options: { history: { type: "string" }, plane: { type: "string" }, out: { type: "string" } } });
  const card = baselineCard(readHistory(values.history), values.plane);
  if (!card) return console.log(`No nightly history for ${values.plane}.`);
  writeFileSync(values.out, `${JSON.stringify(parseScorecard(card), null, 2)}\n`);
  console.log(`Baseline for ${values.plane}: median of ${card.run.id}.`);
}

function evidence(argv) {
  console.log(countsAsEvidence(parseScorecard(readJson(argv[0]))) ? "yes" : "no");
}

async function goOutput() {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.startsWith("{")) continue;
    const event = JSON.parse(line);
    if (event.Output) process.stdout.write(event.Output);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "build") build(rest);
else if (command === "diff") await diff(rest);
else if (command === "comment") comment(rest);
else if (command === "append") await append(rest);
else if (command === "baseline") baseline(rest);
else if (command === "evidence") evidence(rest);
else if (command === "go-output") await goOutput();
else throw new Error("Usage: scorecard.mjs build|diff|comment|append|baseline|evidence|go-output");
