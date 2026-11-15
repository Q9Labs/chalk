import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gatedActionIds, gatedSampleFloor, readBudgets } from "./budgets.mjs";
import { SCORECARD_SCHEMA } from "./schema.mjs";

const MIN_GATED_SAMPLES = gatedSampleFloor(await readBudgets());

const chalkSfu = "chalk_sfu";

const root = resolve(import.meta.dirname, "../..");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const run = { id: "promote-run", commit: revision, tier: "promote", environment: "production", startedAt: "2026-11-15T22:00:00.000Z", client: { kind: "browser", browser: "chromium-headless/151", region: "github-hosted", size: "ubuntu-24-04" } };
const card = (metrics) => ({ schema: SCORECARD_SCHEMA, run, mediaPlane: chalkSfu, metrics, dropped: [] });
const leave = card([{ id: "proof.leave_median_ms", unit: "ms", n: 5, p50: 100, p95: 120, source: "leave-proof" }]);
const action = (id, n = 60) => ({ id, unit: "ms", n, p50: 100, p95: 100, source: "latency-kit" });
const node = (args) => spawnSync(process.execPath, [resolve(import.meta.dirname, "scorecard.mjs"), ...args], { cwd: root, encoding: "utf8" });

async function fixture(t, latencyMetrics) {
  const dir = mkdtempSync(join(tmpdir(), "promote-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { leave: join(dir, "leave.json"), latency: join(dir, "latency.json"), merged: join(dir, "merged.json"), summary: join(dir, "summary.md"), output: join(dir, "output.txt"), dir };
  writeFileSync(files.leave, JSON.stringify(leave));
  writeFileSync(files.latency, JSON.stringify(card(latencyMetrics)));
  writeFileSync(files.summary, "");
  writeFileSync(files.output, "");
  return files;
}
const { budgets } = await readBudgets();
const gated = gatedActionIds(budgets, chalkSfu);
const gate = (mode, files, env, latency = files.latency) =>
  spawnSync("bash", ["features/scorecard/promote-gate.sh", mode, files.leave, latency], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "unused", GITHUB_REPOSITORY: "Q9Labs/chalk", GITHUB_RUN_ID: "1", GITHUB_SERVER_URL: "https://github.com", GITHUB_STEP_SUMMARY: files.summary, GITHUB_OUTPUT: files.output, SCORECARD_HISTORY_REMOTE: join(files.dir, "no-history"), SCORECARD_OVERRIDE: "", ...env },
  });

test("the Leave card and the latency card of one Promote merge into one card of every gated action metric", async (t) => {
  const files = await fixture(
    t,
    gated.map((id) => action(id)),
  );
  const merged = node(["merge", "--out", files.merged, files.leave, files.latency]);
  assert.equal(merged.status, 0, merged.stderr);
  const metrics = JSON.parse(readFileSync(files.merged, "utf8")).metrics.map((metric) => metric.id);
  assert.deepEqual(metrics.sort(), ["proof.leave_median_ms", ...gated].sort());
  const scored = node(["diff", "--current", files.merged, "--expect-gated", "--fail-on-gate"]);
  assert.equal(scored.status, 0, scored.stderr);
  assert.match(scored.stdout, /\| Metric \| Samples \| Budget \| Baseline \| Current \| Verdict \|/);
  for (const id of gated) assert.match(scored.stdout, new RegExp(`\\| \`${id.replaceAll(".", "\\.")}\` \\| 60 \\(floor ${MIN_GATED_SAMPLES}\\)`));
});

test("a card of another revision or a metric in two cards is not merged", async (t) => {
  const files = await fixture(t, [action(gated[0])]);
  writeFileSync(files.latency, JSON.stringify({ ...card([action(gated[0])]), run: { ...run, commit: "0".repeat(40) } }));
  assert.match(node(["merge", "--out", files.merged, files.leave, files.latency]).stderr, /not of one plane and revision/);
  writeFileSync(files.latency, JSON.stringify(card([action(gated[0])])));
  assert.match(node(["merge", "--out", files.merged, files.latency, files.latency]).stderr, /is in two cards/);
});

test("the gate fails a latency run that lacks a gated metric or measured it too few times, and the table names it", async (t) => {
  const files = await fixture(t, [...gated.slice(2).map((id) => action(id)), action(gated[1], MIN_GATED_SAMPLES - 1)]);
  assert.equal(node(["merge", "--out", files.merged, files.leave, files.latency]).status, 0);
  const scored = node(["diff", "--current", files.merged, "--expect-gated", "--fail-on-gate"]);
  assert.equal(scored.status, 1);
  assert.match(scored.stdout, new RegExp(`${gated[0].replaceAll(".", "\\.")}\` \\| 0 \\(floor ${MIN_GATED_SAMPLES}\\).*missing`));
  assert.match(scored.stdout, new RegExp(`${gated[1].replaceAll(".", "\\.")}\` \\| ${MIN_GATED_SAMPLES - 1} .*too few samples`));
  assert.match(scored.stderr, /2 gated metric\(s\) have no samples, too few or timed out/);
});

test("Promote's gate asks for one rerun when the latency run is missing or thin, and passes a complete one", async (t) => {
  const complete = await fixture(
    t,
    gated.map((id) => action(id)),
  );
  assert.equal(gate("first", complete, { LATENCY_EXPECTED: "true" }).status, 0);
  assert.match(readFileSync(complete.output, "utf8"), /over=false/);

  const thin = await fixture(
    t,
    gated.map((id) => action(id, 3)),
  );
  assert.equal(gate("first", thin, { LATENCY_EXPECTED: "true" }).status, 0);
  assert.match(readFileSync(thin.output, "utf8"), /over=true/);

  const missing = await fixture(t, []);
  const first = gate("first", missing, { LATENCY_EXPECTED: "true" }, join(missing.dir, "absent.json"));
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFileSync(missing.output, "utf8"), /over=true/);
  assert.match(readFileSync(missing.summary, "utf8"), /produced no scorecard/);

  const skipped = gate("first", missing, { LATENCY_EXPECTED: "false" }, join(missing.dir, "absent.json"));
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(readFileSync(missing.output, "utf8"), /over=false$/m);
});

// The kit leaves a timed-out action out of the percentiles and lists it as a drop, so the table alone would show a healthy metric.
test("a timeout on a gated metric is a breach even when the other samples are fast", async (t) => {
  const files = await fixture(
    t,
    gated.map((id) => action(id, 48)),
  );
  writeFileSync(files.latency, JSON.stringify({ ...card(gated.map((id) => action(id, 48))), dropped: [{ metric: gated[0], reason: "timeout", count: 12 }] }));
  assert.equal(node(["merge", "--out", files.merged, files.leave, files.latency]).status, 0);
  const scored = node(["diff", "--current", files.merged, "--expect-gated", "--fail-on-gate"]);
  assert.equal(scored.status, 1);
  assert.match(scored.stdout, new RegExp(`${gated[0].replaceAll(".", "\\.")}\` \\| 48 .*timed out`));
  assert.match(scored.stderr, new RegExp(`${gated[0].replaceAll(".", "\\.")} \\(timed out: 48 of ${MIN_GATED_SAMPLES}\\)`));
  assert.equal(gate("first", files, { LATENCY_EXPECTED: "true" }).status, 0);
  assert.match(readFileSync(files.output, "utf8"), /over=true/);
});
