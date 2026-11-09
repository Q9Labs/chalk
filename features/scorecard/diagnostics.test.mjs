import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gatedActionIds, readBudgets } from "./budgets.mjs";
import { DIAGNOSTICS_SCHEMA, diagnosticsFileName, diagnosticsReport, problemOf } from "./diagnostics.mjs";
import { METRICS, SCORECARD_SCHEMA, parseScorecard } from "./schema.mjs";
import { AUDIO_KEYS, RETIRED_STAGE_IDS, STAGE_IDS } from "./stages.mjs";

const root = resolve(import.meta.dirname, "../..");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const actionIds = Object.keys(METRICS).filter((id) => id.startsWith("action."));
const stat = { n: 20, p50: 120, p95: 180 };
const summary = { rtt: { sfu_ms: stat, sync_ms: stat }, stages: { "mic_on.sync_fanout": stat, "join.sfu_tracks": { n: 0, p50: null, p95: null } }, audio: { "media.network_jitter_one_way_ms": stat } };
const sidecar = (overrides = {}) => ({
  schema: DIAGNOSTICS_SCHEMA,
  plane: "chalk_sfu",
  cycles: [{ cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", rtt: { sfu_ms: 201.5, sync_ms: null }, stages: { "mic_on.prepare": 12, "mic_on.sync_ack": null }, audio: { "media.network_jitter_one_way_ms": 61.5, "media.playout_ms": null } }],
  summary,
  ...overrides,
});

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

// Inputs that would have thrown out of schema validation when the numbers lived in the card.
const hostile = {
  "negative stage": sidecar({ cycles: [{ cycle: 1, stages: { "mic_on.prepare": -1 } }] }),
  "null rtt container": sidecar({ cycles: [{ cycle: 1, rtt: null }] }),
  "null stages container": sidecar({ cycles: [{ cycle: 1, stages: null }] }),
  "null summary": sidecar({ summary: null }),
  "null stat object": sidecar({ summary: { stages: { "mic_on.prepare": null } } }),
  "NaN percentile": sidecar({ summary: { stages: { "mic_on.prepare": { n: 3, p50: Number.NaN, p95: 4 } } } }),
  "p50 above p95": sidecar({ summary: { stages: { "mic_on.prepare": { n: 3, p50: 9, p95: 4 } } } }),
  "percentiles without samples": sidecar({ summary: { stages: { "mic_on.prepare": { n: 0, p50: 1, p95: 1 } } } }),
  "negative audio": sidecar({ cycles: [{ cycle: 1, audio: { "media.network_jitter_one_way_ms": -1 } }] }),
  "unknown audio part": sidecar({ cycles: [{ cycle: 1, audio: { network_jitter_one_way_ms: 1 } }] }),
  "null audio container": sidecar({ cycles: [{ cycle: 1, audio: null }] }),
  "audio p50 above p95": sidecar({ summary: { audio: { "media.network_jitter_one_way_ms": { n: 3, p50: 9, p95: 4 } } } }),
  "unknown stage": sidecar({ cycles: [{ cycle: 1, stages: { "mic_on.unknown": 1 } }] }),
  "a host name": sidecar({ summary: { host: "sfu.example.com" } }),
  "wrong schema": sidecar({ schema: "other" }),
  "too many cycles": sidecar({ cycles: Array.from({ length: 61 }, (_, index) => ({ cycle: index + 1 })) }),
  "not an object": [],
};

test("a valid sidecar is accepted and a hostile one is named, never thrown", () => {
  assert.equal(problemOf(sidecar()), undefined);
  for (const [name, file] of Object.entries(hostile)) assert.equal(typeof problemOf(file), "string", name);
  for (const [name, file] of Object.entries(hostile)) assert.match(diagnosticsReport(JSON.stringify(file)), /^Action latency diagnostics: invalid, not shown \(/, name);
  assert.match(diagnosticsReport("{broken"), /invalid, not shown \(not JSON\)/);
  assert.match(diagnosticsReport("null"), /invalid, not shown/);
  assert.match(diagnosticsReport(undefined), /none recorded/);
});

test("the report lists measured stages", () => {
  const text = diagnosticsReport(JSON.stringify(sidecar()));
  assert.match(text, /Round trip from the runner: SFU 120 \/ 180 ms \(n=20\); Sync 120 \/ 180 ms \(n=20\)\./);
  assert.match(text, /\*\*Microphone on\*\*/);
  assert.match(text, /\| `sync_fanout` \| previous stage \| 20 \| 120 \| 180 \|/);
  assert.match(text, /\| `sfu_tracks` \| call \| 0 \| – \| – \|/);
  assert.doesNotMatch(text, /Camera on/);
  assert.match(text, /\*\*Audio delay a listener adds\*\*/);
  assert.match(text, /\| `media.network_jitter_one_way_ms` \| 20 \| 120 \| 180 \| one-way network time plus listener jitter-buffer delay; capture, encode, SFU forwarding and playout are excluded \|/);
  assert.doesNotMatch(diagnosticsReport(JSON.stringify(sidecar({ summary: { ...summary, audio: undefined } }))), /Audio delay/);
});

test("a sidecar written before the turn-off stages were retired still validates and shows the remaining stages", () => {
  const empty = { n: 0, p50: null, p95: null };
  const retiredNull = Object.fromEntries(RETIRED_STAGE_IDS.map((id) => [id, null]));
  const retiredSummary = Object.fromEntries(RETIRED_STAGE_IDS.map((id, index) => [id, index % 2 ? empty : stat]));
  assert.equal(RETIRED_STAGE_IDS.length, 6);
  assert.ok(RETIRED_STAGE_IDS.every((id) => !STAGE_IDS.includes(id)));
  const legacy = sidecar({
    cycles: [{ cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", stages: { "camera_off.prepare": 592, "camera_off.track_removed": 2, ...retiredNull } }, { cycle: 2, stages: { "mic_off.close_tracks": 150, "screen_stop.renegotiate": 30 } }],
    summary: { stages: { "camera_off.track_removed": stat, "camera_off.sfu_close": stat, ...retiredSummary } },
  });
  assert.equal(problemOf(legacy), undefined);
  const report = diagnosticsReport(JSON.stringify(legacy));
  assert.doesNotMatch(report, /invalid, not shown/);
  assert.match(report, /`track_removed`/);
  assert.match(report, /`sfu_close`/);
  assert.doesNotMatch(report, /close_tracks/);
});

test("the audio parts are unique and no budget names them", async () => {
  assert.equal(new Set(AUDIO_KEYS).size, AUDIO_KEYS.length);
  assert.ok(AUDIO_KEYS.every((id) => id.startsWith("media.")));
  const { budgets } = await readBudgets();
  assert.equal(JSON.stringify(budgets).includes("network_jitter"), false);
});

test("every stage id in the registry is unique and belongs to a group", () => {
  assert.equal(new Set(STAGE_IDS).size, STAGE_IDS.length);
  assert.ok(STAGE_IDS.every((id) => /^[a-z_]+\.[a-z_]+$/.test(id)));
});

// Readers that shipped before this change reject a card with a field they do not know. The kit's numbers therefore stay out of
// the card: the card schema accepts none of them, and the gate never opens the sidecar.
test("the scorecard schema takes no diagnostics, round trips or stages", () => {
  const cycle = { cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", actions: Object.fromEntries(actionIds.map((id) => [id, 100])) };
  assert.doesNotThrow(() => parseScorecard(card({ series: [cycle] })));
  assert.throws(() => parseScorecard(card({ diagnostics: summary })), /unknown field diagnostics/);
  assert.throws(() => parseScorecard(card({ series: [{ ...cycle, rtt: { sfu_ms: 1 } }] })), /unknown field rtt/);
  assert.throws(() => parseScorecard(card({ series: [{ ...cycle, stages: { "mic_on.prepare": 1 } }] })), /unknown field stages/);
  assert.throws(() => parseScorecard(card({ series: [{ ...cycle, audio: { "media.network_jitter_one_way_ms": 1 } }] })), /unknown field audio/);
  assert.throws(() => parseScorecard(card({ metrics: [...card().metrics, { id: "media.network_jitter_one_way_ms", unit: "ms", n: 20, p50: 60, p95: 70, source: "latency-kit" }] })), /media.network_jitter_one_way_ms/);
});

// With the sidecar beside the card, in good or hostile shape, every gate command gives the same verdict and exit status as without
// it: passed, a gated breach, and a missing gated metric. The run summary is the only reader, and it shows bad input as text.
test("a sidecar, even a hostile one, cannot change a verdict, a gate exit code or the history", async () => {
  const { budgets } = await readBudgets();
  const gated = gatedActionIds(budgets, "chalk_sfu");
  const variants = {
    passed: card(),
    breach: card({ metrics: card().metrics.map((metric) => (metric.id === gated[0] ? { ...metric, p50: 1e6, p95: 1e6 } : metric)) }),
    missing: card({ metrics: card().metrics.filter((metric) => metric.id !== gated[0]) }),
  };
  const directory = mkdtempSync(join(tmpdir(), "scorecard-diagnostics-"));
  try {
    const run = (script, args, env = {}) => {
      const result = spawnSync("node", [resolve(import.meta.dirname, script), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env } });
      return { status: result.status, stdout: result.stdout };
    };
    const outcomes = {};
    for (const [name, base] of Object.entries(variants)) {
      const cases = { plain: undefined, valid: JSON.stringify(sidecar()), ...Object.fromEntries(Object.entries(hostile).map(([label, file]) => [label, JSON.stringify(file)])), "not json": "{broken" };
      const results = [];
      for (const [label, text] of Object.entries(cases)) {
        const folder = join(directory, name, label.replaceAll(" ", "-"));
        mkdirSync(folder, { recursive: true });
        const cardPath = join(folder, "scorecard-chalk_sfu.json");
        writeFileSync(cardPath, JSON.stringify(base));
        if (text !== undefined) writeFileSync(join(folder, diagnosticsFileName("chalk_sfu")), text);
        const history = join(folder, "history");
        mkdirSync(history);
        results.push({
          label,
          evaluate: run("evaluate.mjs", [revision, "1", cardPath]),
          diff: run("scorecard.mjs", ["diff", "--current", cardPath, "--fail-on-gate"]).status,
          append: run("scorecard.mjs", ["append", "--history", history, cardPath]).status,
          baseline: run("scorecard.mjs", ["baseline", "--history", history, "--plane", "chalk_sfu", "--out", join(folder, "baseline.json")]).status,
          historyLines: readFileSync(join(history, "history.jsonl"), "utf8").trim().split("\n").length,
        });
      }
      const [plain, ...rest] = results;
      for (const result of rest) assert.deepEqual({ ...result, label: undefined }, { ...plain, label: undefined }, `${name}: ${result.label}`);
      outcomes[name] = JSON.parse(plain.evaluate.stdout).result;
    }
    assert.deepEqual(outcomes, { passed: "passed", breach: "gated-breach", missing: "missing" });

    // The run summary step: same exit status and card copy with any sidecar, and the sidecar only changes the diagnostics lines.
    const collect = (label, text) => {
      const evidence = join(directory, "collect", label, "evidence");
      const artifacts = join(directory, "collect", label, "artifacts");
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "scorecard-chalk_sfu.json"), JSON.stringify(card()));
      if (text !== undefined) writeFileSync(join(evidence, diagnosticsFileName("chalk_sfu")), text);
      const result = run("own-sfu.mjs", [evidence, "chalk_sfu", revision, artifacts]);
      return { ...result, copied: existsSync(join(artifacts, "scorecard-chalk_sfu.json")), stdout: result.stdout.split(/(?:#### )?Action latency diagnostics/)[0] };
    };
    const without = collect("none");
    assert.equal(without.status, 0);
    assert.equal(without.copied, true);
    for (const [label, file] of Object.entries({ valid: sidecar(), ...hostile })) assert.deepEqual(collect(label.replaceAll(" ", "-"), JSON.stringify(file)), without, label);
    assert.deepEqual(collect("broken", "{broken"), without);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
