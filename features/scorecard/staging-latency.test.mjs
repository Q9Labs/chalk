import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DIAGNOSTICS_SCHEMA, diagnosticsFileName } from "./diagnostics.mjs";

function run(t, { token = "synthetic-metrics-token", fail = false, preflightSession = false, foreignJoin = true, standby = false, sidecar } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "staging-observation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, ".private"));
  if (sidecar) writeFileSync(join(directory, "sidecar.json"), JSON.stringify(sidecar));
  writeFileSync(join(directory, ".private/staging-lease.json"), JSON.stringify({ acquired: true, lost: false }));
  const preload = join(directory, "boundaries.cjs");
  // Run the real orchestrator; replace only external I/O, workload spawning and time.
  writeFileSync(
    preload,
    String.raw`
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
let clock = Date.now(), phase = "before", activeStart, sequence = 0, foreignJoined, workloadStarted = false;
const events = [];
Date.now = () => clock;
require("node:timers/promises").setTimeout = async (ms) => { clock += ms; };
cp.execFileSync = () => "a".repeat(40);
cp.spawn = (program, args, options) => {
  assert.equal(program, "timeout");
  assert.equal(options.env.CHALK_AXIOM_METRICS_QUERY_TOKEN, undefined);
  workloadStarted = true;
  fs.appendFileSync(".private/workloads-started", "workload\n");
  const id = options.env.CHALK_PROOF_RUN_ID;
  const episode = "own-" + sequence;
  const dir = path.join(".private/prod-proof", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "episodes.jsonl"), JSON.stringify(episode) + "\n");
  fs.writeFileSync(path.join(dir, "scorecard-chalk_sfu.json"), JSON.stringify({ schema: "chalk.scorecard/v1", run: { id, commit: "a".repeat(40), tier: "nightly", environment: "staging", startedAt: new Date(clock).toISOString(), client: { kind: "browser", browser: "test", region: "test", size: "test" } }, mediaPlane: "chalk_sfu", metrics: [{ id: "action.leave_ms", unit: "ms", n: 20, p50: 200, p95: 300, source: "latency-kit" }], dropped: [] }));
  // The latency kit writes its diagnostics sidecar beside its card.
  if (process.env.TEST_SIDECAR) fs.copyFileSync(process.env.TEST_SIDECAR, path.join(dir, "latency-diagnostics-chalk_sfu.json"));
  activeStart = clock;
  events.push({ time: clock + 1000, episode_id: episode, session_id: "own-session" });
  clock += 300000;
  phase = "window";
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", 0));
  return child;
};
require("node:module").syncBuiltinESMExports();
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  if (body.mpl) {
    if (process.env.TEST_METRICS_FAILURE === "yes" || (process.env.TEST_METRICS_FAILURE === "after-workload" && workloadStarted)) throw new Error("sensitive-response-marker");
    // Axiom rejects a query whose end is not after its start.
    if (Date.parse(body.endTime) <= Date.parse(body.startTime)) return { status: 400 };
    const metric = body.mpl.match(/:(?:\x60)([^\x60]+)\x60/)[1];
    if (process.env.TEST_PREFLIGHT_SESSION === "yes") {
      // A persistent session joins while the first historical metric request runs.
      foreignJoined ??= clock + 1000;
      clock += 5000;
    }
    const foreign = foreignJoined !== undefined && Date.parse(body.endTime) >= foreignJoined;
    const value = metric.endsWith("steal") ? 0.01 : metric.endsWith("sessions") ? foreign ? 1 : Date.parse(body.startTime) === activeStart ? 3 : 0 : 0;
    const nodes = process.env.TEST_STANDBY === "yes" ? ["boot-a", "boot-standby"] : ["boot-a"];
    return { status: 200, json: async () => ({ metadata: { unit: "1" }, series: nodes.map((node) => ({ metric, tags: { "service.instance.id": node, "service.name": "chalk-sfu", "deployment.environment.name": "staging" }, start: 0, resolution: 1, data: [node === "boot-a" ? value : 0], summary: value })) }) };
  }
  if (phase === "before") {
    sequence++;
    // Join after the quiet window but before the workload, then remain API-silent.
    if (process.env.TEST_FOREIGN_JOIN === "yes") events.push({ time: Date.parse(body.endTime) + 5000, episode_id: "foreign-" + sequence, session_id: "foreign-session" });
    phase = "preflight";
  } else if (phase === "window") phase = "after";
  else if (phase === "after") phase = "before";
  const rows = events.filter((event) => event.time >= Date.parse(body.startTime) && event.time < Date.parse(body.endTime));
  return { ok: true, json: async () => ({ status: {}, tables: [{ fields: [{ name: "episode_id" }, { name: "session_id" }], columns: [rows.map((row) => row.episode_id), rows.map((row) => row.session_id)] }] }) };
};
`,
  );
  const result = spawnSync(process.execPath, ["--require", preload, resolve(import.meta.dirname, "staging-latency.mjs"), "--leased"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      RUN_PREFIX: "test-job",
      GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
      CHALK_AXIOM_QUERY_TOKEN: "synthetic-api-token",
      CHALK_AXIOM_STAGING_LOG_DATASET: "test-api",
      CHALK_AXIOM_METRICS_QUERY_TOKEN: token,
      CHALK_AXIOM_STAGING_METRICS_DATASET: "test-metrics",
      CHALK_AXIOM_METRICS_BASE_URL: "https://us-east-1.aws.edge.axiom.co",
      TEST_METRICS_FAILURE: fail === true ? "yes" : fail || "no",
      TEST_PREFLIGHT_SESSION: preflightSession ? "yes" : "no",
      TEST_FOREIGN_JOIN: foreignJoin ? "yes" : "no",
      TEST_STANDBY: standby ? "yes" : "no",
      TEST_SIDECAR: sidecar ? join(directory, "sidecar.json") : "",
    },
  });
  return { result, card: JSON.parse(readFileSync(join(directory, ".private/latency-scorecard/scorecard-chalk_sfu.json"), "utf8")), summary: join(directory, "summary.md"), directory };
}

test("a foreign join during metric preflight cannot enter an isolated baseline", (t) => {
  const { result, card } = run(t);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(card.contention.foreign_episodes_seen.value, 1);
  assert.equal(card.contention.contended, true);
  assert.equal(card.contention.own_episode_events.value, 1);
});

test("a session appearing during metric preflight prevents the workload from starting", (t) => {
  const { result, card, directory } = run(t, { preflightSession: true });
  assert.equal(result.status, 1, result.stderr);
  assert.throws(() => readFileSync(join(directory, ".private/workloads-started")), { code: "ENOENT" });
  assert.equal(card.contention.foreign_sessions_seen.value, 1);
  assert.equal(card.contention.contended, true);
  assert.equal(card.metrics.length, 0);
  // The skipped workload says why and sends Axiom no zero-width window.
  assert.match(result.stdout, /No workload started/);
  assert.ok(!result.stderr.includes("HTTP 400"), result.stderr);
});

test("an idle standby beside the idle primary does not stop the workload or taint the card", (t) => {
  const { result, card, directory } = run(t, { standby: true, foreignJoin: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(directory, ".private/workloads-started")), true);
  assert.equal(card.contention.contended, false);
  assert.equal(card.contention.incarnation_changes.value, 0);
});

test("metric failures retain bounded redacted reasons without raw exception text", (t) => {
  for (const [token, fail, reason] of [
    ["", false, "staging_metrics_configuration_missing"],
    ["synthetic-metrics-token", true, "staging_metrics_query_unavailable"],
  ]) {
    const { result, card, summary, directory } = run(t, { token, fail, foreignJoin: false });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(reason));
    assert.ok(readFileSync(summary, "utf8").includes(reason));
    assert.ok(!result.stderr.includes("sensitive-response-marker"));
    assert.equal(card.contention.steal_max.value, "unavailable");
    assert.equal(card.contention.contended, false);
    assert.equal(card.contention.unobservable, true);
    assert.equal(existsSync(join(directory, ".private/workloads-started")), false);
  }
});

test("postflight metric failure preserves measurements as unobservable and fails closed", (t) => {
  const { result, card, directory } = run(t, { fail: "after-workload", foreignJoin: false });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(card.metrics.length, 1);
  assert.equal(card.contention.contended, false);
  assert.equal(card.contention.unobservable, true);
  assert.equal(existsSync(join(directory, ".private/workloads-started")), true);
  const root = resolve(import.meta.dirname, "../..");
  const collected = spawnSync(process.execPath, [resolve(import.meta.dirname, "own-sfu.mjs"), join(directory, ".private/latency-scorecard"), "chalk_sfu", "a".repeat(40), join(directory, "artifacts")], { cwd: root, encoding: "utf8" });
  assert.equal(collected.status, 1, collected.stderr);
  assert.match(collected.stdout, /unavailable/);
});

test("the diagnostics sidecar travels from the latency run to the summary and the artifact, outside the card", (t) => {
  const stat = { n: 20, p50: 120, p95: 180 };
  const pair = { local_type: "host", remote_type: "srflx", requests_sent: 8, responses_received: 5 };
  const iceSummary = { pairs: { "host/srflx": 20 }, unanswered_checks: { n: 20, p50: 3, p95: 3 } };
  const sidecar = { schema: DIAGNOSTICS_SCHEMA, plane: "chalk_sfu", cycles: [{ cycle: 1, ice: pair }], summary: { rtt: { sfu_ms: stat, sync_ms: stat }, stages: { "mic_on.sync_fanout": stat }, ice: iceSummary } };
  const root = resolve(import.meta.dirname, "../..");
  const collect = ({ directory }) => {
    const artifacts = join(directory, "artifacts");
    const collected = spawnSync(process.execPath, [resolve(import.meta.dirname, "own-sfu.mjs"), join(directory, ".private/latency-scorecard"), "chalk_sfu", "a".repeat(40), artifacts], { cwd: root, encoding: "utf8" });
    return { collected, artifacts, carried: existsSync(join(directory, ".private/latency-scorecard", diagnosticsFileName("chalk_sfu"))) };
  };

  const plain = run(t, { foreignJoin: false });
  const withSidecar = run(t, { foreignJoin: false, sidecar });
  const plainOut = collect(plain);
  const out = collect(withSidecar);

  assert.equal(withSidecar.result.status, plain.result.status, withSidecar.result.stderr);
  for (const { card } of [plain, withSidecar]) delete card.run.startedAt;
  assert.deepEqual(withSidecar.card, plain.card);
  assert.equal(out.collected.status, plainOut.collected.status);
  assert.equal(plainOut.carried, false);
  assert.match(plainOut.collected.stdout, /diagnostics: none recorded/);
  assert.equal(out.carried, true);
  assert.match(out.collected.stdout, /Action latency diagnostics/);
  assert.match(out.collected.stdout, /Microphone on/);
  assert.match(out.collected.stdout, /Selected pairs: host\/srflx 20\./);
  const uploaded = JSON.parse(readFileSync(join(out.artifacts, diagnosticsFileName("chalk_sfu")), "utf8"));
  assert.deepEqual(uploaded.cycles[0].ice, pair);
  assert.deepEqual(uploaded.summary.ice, iceSummary);
  assert.ok(existsSync(join(out.artifacts, diagnosticsFileName("chalk_sfu"))));
  assert.ok(existsSync(join(out.artifacts, "scorecard-chalk_sfu.json")));
});
