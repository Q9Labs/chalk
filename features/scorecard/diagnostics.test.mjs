import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gatedActionIds, readBudgets } from "./budgets.mjs";
import { diagnosticsMarkdown } from "./diagnostics.mjs";
import { baselineCard } from "./history.mjs";
import { METRICS, SCORECARD_SCHEMA, parseScorecard } from "./schema.mjs";
import { STAGE_IDS } from "./stages.mjs";

const root = resolve(import.meta.dirname, "../..");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const actionIds = Object.keys(METRICS).filter((id) => id.startsWith("action."));
const stat = { n: 20, p50: 120, p95: 180 };
const diagnostics = { rtt: { sfu_ms: stat, sync_ms: stat }, stages: { "mic_on.sync_fanout": stat, "join.sfu_tracks": { n: 0, p50: null, p95: null } } };
const cycle = (extra = {}) => ({ cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", actions: Object.fromEntries(actionIds.map((id) => [id, 100])), ...extra });

function card(overrides = {}) {
  const metrics = actionIds.map((id) => ({ id, unit: "ms", n: 20, p50: 100, p95: 100, source: "latency-kit" }));
  return {
    schema: SCORECARD_SCHEMA,
    run: { id: "nightly-1", commit: revision, tier: "nightly", environment: "staging", startedAt: "2026-11-08T00:00:00.000Z", client: { kind: "browser", browser: "chromium/151", region: "github-hosted", size: "ubuntu-24-04" } },
    mediaPlane: "chalk_sfu",
    metrics,
    dropped: [],
    ...overrides,
  };
}

test("series rtt, series stages and diagnostics are optional and validated", () => {
  assert.doesNotThrow(() => parseScorecard(card({ series: [cycle()] })));
  const full = card({ series: [cycle({ rtt: { sfu_ms: 201.5, sync_ms: null }, stages: { "mic_on.prepare": 12, "mic_on.sync_ack": null } })], diagnostics });
  assert.equal(parseScorecard(full).diagnostics.rtt.sfu_ms.p95, 180);
  const bad = (value, pattern) => assert.throws(() => parseScorecard(value), pattern);
  bad(card({ series: [cycle({ stages: { "mic_on.unknown": 1 } })] }), /unknown field mic_on.unknown/);
  bad(card({ series: [cycle({ stages: { "mic_on.prepare": -1 } })] }), /non-negative milliseconds or null/);
  bad(card({ series: [cycle({ rtt: { udp_ms: 1 } })] }), /unknown field udp_ms/);
  bad(card({ diagnostics: { stages: { "mic_on.prepare": { n: 3, p50: 9, p95: 4 } } } }), /p50 is above p95/);
  bad(card({ diagnostics: { stages: { "mic_on.prepare": { n: 0, p50: 1, p95: 1 } } } }), /must be null without samples/);
  bad(card({ diagnostics: { host: "sfu.example.com" } }), /unknown field host/);
});

test("every stage id in the registry is unique and belongs to a group", () => {
  assert.equal(new Set(STAGE_IDS).size, STAGE_IDS.length);
  assert.ok(STAGE_IDS.every((id) => /^[a-z_]+\.[a-z_]+$/.test(id)));
});

test("the diagnostics table lists measured stages and nothing for a card without them", () => {
  assert.equal(diagnosticsMarkdown(undefined), "");
  const text = diagnosticsMarkdown(diagnostics);
  assert.match(text, /Round trip from the runner: SFU 120 \/ 180 ms \(n=20\); Sync 120 \/ 180 ms \(n=20\)\./);
  assert.match(text, /\*\*Microphone on\*\*/);
  assert.match(text, /\| `sync_fanout` \| previous stage \| 20 \| 120 \| 180 \|/);
  assert.match(text, /\| `sfu_tracks` \| call \| 0 \| – \| – \|/);
  assert.doesNotMatch(text, /Camera on/);
});

test("the median baseline carries no series or diagnostics", () => {
  const baseline = baselineCard([parseScorecard(card({ series: [cycle()], diagnostics }))], "chalk_sfu");
  assert.equal(Object.hasOwn(baseline, "series"), false);
  assert.equal(Object.hasOwn(baseline, "diagnostics"), false);
});

// The nightly verdict and the diff exit code read metrics, budgets and contention only. These runs prove it: the same
// card with and without the new fields, including absurd values, gives the same verdict text and exit status.
test("new fields cannot change the evaluate verdict or the diff exit code", async () => {
  const { budgets } = await readBudgets();
  const gated = gatedActionIds(budgets, "chalk_sfu");
  const extra = { series: [cycle({ rtt: { sfu_ms: 999999, sync_ms: 999999 }, stages: { "mic_on.prepare": 999999 } })], diagnostics: { rtt: { sfu_ms: { n: 1, p50: 999999, p95: 999999 } }, stages: { "mic_on.prepare": { n: 1, p50: 999999, p95: 999999 } } } };
  const variants = {
    passed: card(),
    breach: card({ metrics: card().metrics.map((metric) => (metric.id === gated[0] ? { ...metric, p50: 1e6, p95: 1e6 } : metric)) }),
    missing: card({ metrics: card().metrics.filter((metric) => metric.id !== gated[0]) }),
  };
  const directory = mkdtempSync(join(tmpdir(), "scorecard-diagnostics-"));
  try {
    const run = (script, args) => {
      const result = spawnSync("node", [resolve(import.meta.dirname, script), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
      return { status: result.status, stdout: result.stdout };
    };
    const outcomes = {};
    for (const [name, base] of Object.entries(variants)) {
      const plain = join(directory, `${name}-plain.json`);
      const rich = join(directory, `${name}-rich.json`);
      writeFileSync(plain, JSON.stringify(base));
      writeFileSync(rich, JSON.stringify({ ...base, ...extra }));
      const evaluated = [run("evaluate.mjs", [revision, "1", plain]), run("evaluate.mjs", [revision, "1", rich])];
      assert.deepEqual(evaluated[1], evaluated[0], `${name}: evaluate`);
      outcomes[name] = JSON.parse(evaluated[0].stdout).result;
      const diffed = [run("scorecard.mjs", ["diff", "--current", plain, "--fail-on-gate"]), run("scorecard.mjs", ["diff", "--current", rich, "--fail-on-gate"])];
      assert.equal(diffed[1].status, diffed[0].status, `${name}: diff exit status`);
    }
    assert.deepEqual(outcomes, { passed: "passed", breach: "gated-breach", missing: "missing" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
