import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SCORECARD_SCHEMA } from "./schema.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(import.meta.dirname, "own-sfu.mjs");
const revision = "abcdef0123456789abcdef0123456789abcdef01";

function collect(metrics) {
  const dir = mkdtempSync(join(tmpdir(), "scorecard-own-sfu-"));
  const evidence = join(dir, "evidence", "run-latency");
  mkdirSync(evidence, { recursive: true });
  if (metrics) {
    const run = { id: "run-latency", commit: revision, tier: "nightly", environment: "staging", startedAt: "2026-11-08T03:00:00.000Z", client: { kind: "browser", browser: "chromium-headless/151", region: "github-hosted", size: "ubuntu-24-04" } };
    writeFileSync(join(evidence, "scorecard-chalk_sfu.json"), JSON.stringify({ schema: SCORECARD_SCHEMA, run, mediaPlane: "chalk_sfu", metrics, dropped: [] }));
  }
  const summary = join(dir, "summary.md");
  const artifacts = join(dir, "artifacts");
  const result = spawnSync("node", [script, join(dir, "evidence"), "chalk_sfu", revision, artifacts], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  return { result, artifacts, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
}

test("a card with metrics is copied to the artifact folder and shown against its budgets", () => {
  const { result, artifacts, summary } = collect([{ id: "action.leave_ms", unit: "ms", n: 20, p50: 305, p95: 456, source: "latency-kit" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(artifacts, "scorecard-chalk_sfu.json")));
  assert.match(summary, /Own SFU nightly: chalk_sfu at abcdef012/);
  assert.match(summary, /action\.leave_ms/);
  assert.match(summary, /p95 ≤ 950/);
  assert.match(summary, /✅/);
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
