import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendCards, baselineCard, readHistory, trendsMarkdown } from "./history.mjs";
import { SCORECARD_SCHEMA, scorecardProblems } from "./schema.mjs";

const night = (day, leaveMs, plane = "chalk_sfu") => ({
  schema: SCORECARD_SCHEMA,
  run: { id: `run-${day}`, commit: "b".repeat(40), tier: "nightly", environment: "staging", startedAt: `2026-11-${String(day).padStart(2, "0")}T03:00:00.000Z`, client: { kind: "browser", browser: "chromium/150.0.1", region: "github-hosted", size: "ubuntu-24-04" } },
  mediaPlane: plane,
  metrics: [{ id: "action.leave_ms", unit: "ms", n: 20, p50: leaveMs, p95: leaveMs * 2, source: "latency-kit" }],
  dropped: [],
});
const directory = () => mkdtempSync(join(tmpdir(), "scorecard-history-"));

test("appending the same run twice leaves history unchanged", () => {
  const dir = directory();
  assert.equal(appendCards(dir, [night(1, 100), night(2, 110)]), 2);
  assert.equal(appendCards(dir, [night(2, 110), night(3, 120)]), 1);
  assert.equal(appendCards(dir, [night(4, 130), night(4, 130)]), 1);
  assert.deepEqual(
    readHistory(dir).map((card) => card.run.id),
    ["run-1", "run-2", "run-3", "run-4"],
  );
  assert.equal(readFileSync(join(dir, "history.jsonl"), "utf8").split("\n").length, 5);
});

test("the baseline is the median of the last seven nightly runs of one plane", () => {
  const history = [...Array.from({ length: 9 }, (_, index) => night(index + 1, 100 + index * 10)), night(10, 999, "cf_sfu")];
  const baseline = baselineCard(history, "chalk_sfu");
  assert.equal(baseline.run.id, "median-of-7");
  assert.deepEqual(scorecardProblems(baseline), []);
  // runs 3 to 9 have p50 120..180, so the median is 150 and the median p95 is 300
  assert.deepEqual([baseline.metrics[0].p50, baseline.metrics[0].p95, baseline.metrics[0].n], [150, 300, 140]);
  assert.equal(baselineCard([], "chalk_sfu"), undefined);
});

test("the trends list the last 14 values, p95 where the budget bounds the p95", () => {
  const history = Array.from({ length: 16 }, (_, index) => night(index + 1, 100 + index));
  const table = trendsMarkdown(history, { "action.leave_ms": { max_p95: 500, tolerancePct: 10, gate: false } });
  const row = table.split("\n").find((line) => line.startsWith("| `action.leave_ms`"));
  const values = row.split("|")[3].trim().split(" ");
  assert.equal(values.length, 14);
  assert.equal(values[0], "204"); // run 3: p50 102, p95 204
  assert.equal(values.at(-1), "230");
});

test("a plane's own p95 budget picks the p95 for that plane only", () => {
  const history = [night(1, 100), night(2, 100, "cf_sfu")];
  const table = trendsMarkdown(history, { "chalk_sfu.action.leave_ms": { max_p95: 500, tolerancePct: 10, gate: false } });
  const [cf, chalk] = table.split("## chalk_sfu");
  assert.match(chalk, /\| `action.leave_ms` \| ms \| 200 \|/);
  assert.match(cf, /\| `action.leave_ms` \| ms \| 100 \|/);
});
