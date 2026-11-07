import assert from "node:assert/strict";
import test from "node:test";
import { diffMetrics, renderTable } from "./diff.mjs";

const ms = (id, p50, p95 = p50) => ({ id, unit: "ms", n: 20, p50, p95, source: "t" });
const budgets = {
  "action.join.first_audio_ms": { max_p95: 1000, tolerancePct: 10, gate: true },
  "action.leave_ms": { max_p95: 500, tolerancePct: 10, gate: false },
  "action.mic_toggle.on_ms": { max_p95: 900, tolerancePct: 10, gate: true },
  "action.mic_toggle.off_ms": { max_p95: 900, tolerancePct: 10, gate: true },
  "proof.leave_median_ms": { max_p50: 800, tolerancePct: 10, gate: false },
  "device.ice_restart.pass": { min_p50: 1, tolerancePct: 0, gate: true },
};

test("each status follows the budget first, then the baseline and the tolerance", () => {
  const baseline = [ms("action.join.first_audio_ms", 400, 600), ms("action.leave_ms", 300, 400), ms("action.mic_toggle.on_ms", 300, 500), ms("action.mic_toggle.off_ms", 300, 500), ms("action.camera_toggle.on_ms", 100)];
  const current = [ms("action.join.first_audio_ms", 450, 1200), ms("action.leave_ms", 350, 480), ms("action.mic_toggle.on_ms", 300, 560), ms("action.mic_toggle.off_ms", 300, 400), ms("action.screenshare.start_ms", 700)];
  const { rows, missing, failures } = diffMetrics(baseline, current, budgets);
  const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
  assert.deepEqual(status, {
    "action.join.first_audio_ms": "over", // p95 1200 > 1000
    "action.leave_ms": "worse", // within budget, p95 400 to 480 is +20%
    "action.mic_toggle.on_ms": "worse", // +12% on p95
    "action.mic_toggle.off_ms": "better", // -20% on p95
    "action.screenshare.start_ms": "new",
  });
  assert.deepEqual(missing, ["action.camera_toggle.on_ms"]);
  assert.deepEqual(
    failures.map((row) => row.id),
    ["action.join.first_audio_ms"],
  );
});

test("a warn-only budget that is exceeded is reported but never a failure", () => {
  const { rows, failures } = diffMetrics([], [ms("action.leave_ms", 700, 900)], budgets);
  assert.equal(rows[0].status, "over");
  assert.equal(rows[0].gate, false);
  assert.deepEqual(failures, []);
});

test("a pass rate that falls is over its minimum, and a metric with no samples is not a regression", () => {
  const pass = (rate) => ({ id: "device.ice_restart.pass", unit: "pass", n: 4, p50: rate, p95: rate, source: "t" });
  assert.equal(diffMetrics([pass(1)], [pass(0.75)], budgets).rows[0].status, "over");
  assert.equal(diffMetrics([pass(1)], [pass(1)], budgets).rows[0].status, "same");
  const empty = { ...ms("action.leave_ms", 0), n: 0, p50: null, p95: null };
  assert.equal(diffMetrics([ms("action.leave_ms", 300, 400)], [empty], budgets).rows[0].status, "empty");
});

test("the table lists changed rows only, counts the rest and names the drops", () => {
  const baseline = [ms("action.join.first_audio_ms", 400, 600), ms("action.mic_toggle.off_ms", 300, 500), ms("proof.leave_median_ms", 400)];
  const current = [ms("action.join.first_audio_ms", 450, 1200), ms("action.mic_toggle.off_ms", 300, 400), ms("proof.leave_median_ms", 405)];
  const table = renderTable(diffMetrics(baseline, current, budgets), { title: "Scorecard", baselineLabel: "master", dropped: [{ metric: "*", reason: "cycle_failed", count: 2 }] });
  assert.match(table, /1 over a gated budget, 0 over a warn-only budget, 0 slower or larger than the baseline, 1 better/);
  assert.match(table, /\| ❌ \| `action.join.first_audio_ms` \| 600 \| 1200 ms \| \+100% \| p95 ≤ 1000 \| blocks \|/);
  assert.match(table, /\| ✅ \| `action.mic_toggle.off_ms` \| 500 \| 400 ms \| -20% \|/);
  assert.doesNotMatch(table, /proof.leave_median_ms/);
  assert.match(table, /1 within tolerance, 0 without a baseline\./);
  assert.match(table, /Dropped: whole cycle: cycle_failed ×2\./);
});

test("each job owns one section of the single comment", async () => {
  const { MARKER, upsertSection } = await import("./comment.mjs");
  const first = upsertSection(undefined, "web", "web table");
  assert.ok(first.startsWith(MARKER));
  const both = upsertSection(first, "sfu", "sfu table");
  assert.match(both, /web table[\s\S]*sfu table/);
  const again = upsertSection(both, "web", "newer web table");
  assert.doesNotMatch(again, /\nweb table/);
  assert.match(again, /sfu table[\s\S]*newer web table/);
  assert.equal(again.split(MARKER).length, 2);
});
