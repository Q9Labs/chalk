import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { planeBudgets, readBudgets } from "./budgets.mjs";
import { SCORECARD_SCHEMA } from "./schema.mjs";
import { contention } from "./contention.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(import.meta.dirname, "chalk-sfu.mjs");
const revision = "abcdef0123456789abcdef0123456789abcdef01";

function collect(metrics, isolation) {
  const dir = mkdtempSync(join(tmpdir(), "scorecard-chalk-sfu-"));
  const evidence = join(dir, "evidence", "run-latency");
  mkdirSync(evidence, { recursive: true });
  if (metrics) {
    const run = { id: "run-latency", commit: revision, tier: "nightly", environment: "nightly", startedAt: "2026-11-08T03:00:00.000Z", client: { kind: "browser", browser: "chromium-headless/151", region: "github-hosted", size: "ubuntu-24-04" } };
    writeFileSync(join(evidence, "scorecard-chalk_sfu.json"), JSON.stringify({ schema: SCORECARD_SCHEMA, run, mediaPlane: "chalk_sfu", metrics, dropped: [], ...(isolation ? { contention: isolation } : {}) }));
  }
  const summary = join(dir, "summary.md");
  const artifacts = join(dir, "artifacts");
  const result = spawnSync("node", [script, join(dir, "evidence"), "chalk_sfu", revision, artifacts], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  return { result, artifacts, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
}

const { budgets } = await readBudgets();
const leave = planeBudgets(budgets, "chalk_sfu")["action.leave_ms"];
const leaveMetric = (p95) => ({ id: "action.leave_ms", unit: "ms", n: 20, p50: 305, p95, source: "latency-kit" });
const rowOf = (summary, id) => summary.split("\n").find((line) => line.includes(`\`${id}\``));

test("a card with metrics is copied to the artifact folder and shown against its budget", () => {
  const { result, artifacts, summary } = collect([leaveMetric(Math.floor(leave.max_p95 / 2))]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(artifacts, "scorecard-chalk_sfu.json")));
  assert.match(summary, /Chalk SFU nightly: chalk_sfu at abcdef012/);
  const row = rowOf(summary, "action.leave_ms");
  assert.ok(row, summary);
  assert.ok(row.includes(String(leave.max_p95)), row);
  assert.doesNotMatch(row, /blocks|warns|diagnostic|unavailable/);
});

test("a metric over a gated budget is marked as blocking in the summary", () => {
  assert.equal(leave.gate, true);
  const { summary } = collect([leaveMetric(leave.max_p95 + 1)]);
  assert.match(rowOf(summary, "action.leave_ms") ?? "", /blocks/);
});

test("a card without metrics fails and says so in the summary", () => {
  const { result, artifacts, summary } = collect([]);
  assert.notEqual(result.status, 0);
  assert.match(summary, /has no metrics/);
  assert.ok(!existsSync(join(artifacts, "scorecard-chalk_sfu.json")));
});

test("a missing card fails and says so in the summary", () => {
  const { result, summary } = collect(null);
  assert.notEqual(result.status, 0);
  assert.match(summary, /wrote no scorecard/);
});

test("a contended card, even without metrics, remains an artifact and fails with a clear summary", () => {
  const { result, artifacts, summary } = collect([], contention({}));
  assert.notEqual(result.status, 0);
  assert.match(summary, /CONTENDED/);
  assert.match(summary, /unavailable/);
  const card = JSON.parse(readFileSync(join(artifacts, "scorecard-chalk_sfu.json"), "utf8"));
  assert.equal(card.contention.contended, true);
});
