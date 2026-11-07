import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CALL_DEVICES, CALL_SCENARIOS } from "./metrics.mjs";
import { scenarios } from "../../apps/web/scripts/call-performance-scenarios.mjs";
import { deviceMetrics } from "./adapters/device.mjs";
import { joinStartupMetrics, leaveMedianMetrics } from "./adapters/proof.mjs";
import { goTestMetrics, liveSampleMetrics, nodeLoadMetrics } from "./adapters/sfu.mjs";
import { webMetrics } from "./adapters/web.mjs";
import { METRICS, SCORECARD_SCHEMA, scorecardProblems } from "./schema.mjs";

const budgetsFile = JSON.parse(readFileSync(new URL("../../perf/budgets.json", import.meta.url), "utf8"));

const card = ({ metrics, dropped }) => ({
  schema: SCORECARD_SCHEMA,
  run: { id: "local-1", commit: "a".repeat(40), tier: "pr", environment: "ci", startedAt: "2026-11-07T10:20:30.000Z", client: { kind: "browser", browser: "chromium/150.0.1", region: "github-hosted", size: "ubuntu-24.04" } },
  mediaPlane: "chalk_sfu",
  metrics,
  dropped,
});

test("the web registry covers exactly the scenarios the check runs and the budget file", () => {
  assert.deepEqual(
    CALL_SCENARIOS,
    scenarios.map(({ id }) => id),
  );
  assert.deepEqual(Object.keys(budgetsFile.callRun.devices), CALL_DEVICES);
  const web = Object.keys(METRICS).filter((id) => id.startsWith("web."));
  const budgeted = Object.keys(budgetsFile.budgets).filter((id) => id.startsWith("web."));
  assert.deepEqual([...web].sort(), [...budgeted].sort());
});

test("every budget entry names a registered metric, and a pass budget bounds from below", () => {
  for (const [id, entry] of Object.entries(budgetsFile.budgets)) {
    assert.ok(METRICS[id], `${id} is not in the registry`);
    assert.equal(METRICS[id].unit === "pass", entry.min_p50 !== undefined, `${id}: pass metrics use min_p50 and no other metric does`);
  }
});

test("a bundle-only web report keeps the bundle sizes and takes p50 and p95 from the repeats", () => {
  const sample = (js) => ({ jsGzipKiB: js, cssGzipKiB: 50, interactionMs: 9, firstCallMs: 1 });
  const report = {
    mode: "bundle-only",
    routeBundle: { routeJsGzipKiB: 218.4, routeCssGzipKiB: 30.1 },
    results: [{ device: "laptop", scenario: "first-load", samples: [sample(380), sample(382)] }],
  };
  const result = webMetrics(report);
  assert.deepEqual(
    result.metrics.map((metric) => metric.id),
    ["web.route.js_gzip_kib", "web.route.css_gzip_kib", "web.laptop.first-load.js_gzip_kib", "web.laptop.first-load.css_gzip_kib"],
  );
  const js = result.metrics.find((metric) => metric.id === "web.laptop.first-load.js_gzip_kib");
  assert.deepEqual([js.unit, js.n, js.p50, js.p95], ["kib", 2, 380, 382]);
  assert.deepEqual(scorecardProblems(card(result)), []);
});

test("a full web report adds timings, and firstCallMs only for first-load", () => {
  const sample = { jsGzipKiB: 386, cssGzipKiB: 54, interactionMs: 20, firstCallMs: 1500, frameP95Ms: 80, droppedFramePercent: 50, longTasks: 1, blockingMs: 10, heapMiB: 14, domNodes: 1900, videoDroppedFramePercent: 1, layoutShift: 0 };
  const { metrics } = webMetrics({
    mode: "full",
    results: [
      { device: "phone", scenario: "calm-six", samples: [sample] },
      { device: "phone", scenario: "first-load", samples: [sample] },
    ],
  });
  assert.ok(!metrics.some((metric) => metric.id === "web.phone.calm-six.first_call_ms"));
  assert.ok(metrics.some((metric) => metric.id === "web.phone.first-load.first_call_ms"));
  assert.equal(metrics.length, 11 + 12);
});

test("go test output becomes pass rates, and a test that did not run is reported as dropped", () => {
  const events = [
    { Action: "pass", Test: "TestLoopback" },
    { Action: "pass", Test: "TestLossOnEachLegIsRepairedOverRTX" },
    { Action: "fail", Test: "TestImpairedCallsLogNothingForbidden" },
    { Action: "skip", Test: "TestTenPersonCallWithAScreenShareStaysUnderTheEpisodeCeiling" },
    { Action: "pass", Package: "chalk/sfu/tests" },
  ];
  const { metrics, dropped } = goTestMetrics(events.map((event) => JSON.stringify(event)).join("\n"));
  const rate = Object.fromEntries(metrics.map((metric) => [metric.id, metric.p50]));
  assert.deepEqual(rate, { "sfu.loopback.pass": 1, "sfu.impairment.pass": 0.5 });
  assert.deepEqual(dropped, [{ metric: "sfu.impairment.pass", reason: "test_not_run", count: 3 }]);
});

test("live smoke samples give loss, stalls per class-hour and refusals", () => {
  const sample = (minute, expected, received, stalls, refused) => ({
    at: new Date(Date.UTC(2026, 10, 7, 3, minute)).toISOString(),
    classes: 3,
    ready: { host: refused ? { admissionReason: "cpu_steal" } : {} },
    peers: { expected, received, videoStalls: stalls, screenStalls: 0, audioStalls: 0 },
  });
  const text = [sample(0, 1000, 1000, 0, false), sample(30, 2000, 1980, 3, true), sample(60, 3000, 2970, 6, false)].map((line) => JSON.stringify(line)).join("\n");
  const { metrics, dropped } = liveSampleMetrics(text);
  const by = Object.fromEntries(metrics.map((metric) => [metric.id, metric]));
  assert.equal(by["sfu.loss_pct"].p95, 1);
  assert.equal(by["sfu.admission_refusals"].p50, 1);
  assert.equal(by["sfu.stalls_per_class_hour"].p50, 2);
  assert.deepEqual(dropped, []);
  assert.deepEqual(liveSampleMetrics("").dropped, [{ metric: "*", reason: "no_samples", count: 1 }]);
});

test("node load samples are divided by the classes held, and steal is not work", () => {
  const { metrics } = nodeLoadMetrics({ samples: [{ classes: 3, cpuBusyPercent: 42, stealPercent: 6, ppsIn: 3000, ppsOut: 9000, egressMbitPerSecond: 30, freezeMsPerMinute: 120 }] });
  const by = Object.fromEntries(metrics.map((metric) => [metric.id, metric.p50]));
  assert.deepEqual(by, { "sfu.cpu_work_pct_per_class": 12, "sfu.pps_in_per_class": 1000, "sfu.pps_out_per_class": 3000, "sfu.egress_mbit_s_per_class": 10, "sfu.freeze_ms_per_minute": 120 });
});

test("proof results map to proof.* metrics", () => {
  const live = (scenario, elapsedMs) => ({ revision: "after", scenario, device: "phone", connection: { status: "live" }, elapsedMs });
  const results = [live("retry", 900), live("lossy-stalled", 1200), live("lossy-stalled", 1800), { ...live("lossy-stalled", 99), connection: { status: "failed" } }, { ...live("retry", 5), revision: "before" }];
  const { metrics } = joinStartupMetrics(results);
  assert.deepEqual(
    metrics.map((metric) => [metric.id, metric.n, metric.p95]),
    [
      ["proof.join_startup.retry_ms", 1, 900],
      ["proof.join_startup.lossy_stalled_ms", 2, 1800],
    ],
  );
  const leave = leaveMedianMetrics({ candidateSamples: 5, candidateMedianMs: 410, candidateMaxMs: 640 }).metrics[0];
  assert.deepEqual([leave.id, leave.n, leave.p50, leave.p95], ["proof.leave_median_ms", 5, 410, 640]);
});

test("the device file maps timings of passing runs and a pass rate per scenario", () => {
  const file = {
    scenarios: [
      {
        name: "network_switch",
        runs: [
          { passed: true, ms: 800 },
          { passed: true, ms: 1400 },
          { passed: false, ms: null },
        ],
      },
      { name: "ice_restart", runs: [{ passed: true, ms: 500 }] },
    ],
  };
  const { metrics, dropped } = deviceMetrics(file);
  const by = Object.fromEntries(metrics.map((metric) => [metric.id, metric]));
  assert.deepEqual([by["device.reconnect_ms"].n, by["device.reconnect_ms"].p95], [2, 1400]);
  assert.equal(by["device.network_switch.pass"].p50, 2 / 3);
  assert.equal(by["device.ice_restart.pass"].p50, 1);
  assert.deepEqual(dropped, [{ metric: "device.reconnect_ms", reason: "run_failed", count: 1 }]);
  assert.deepEqual(scorecardProblems(card({ metrics, dropped })), []);
  assert.throws(() => deviceMetrics({ scenarios: [{ name: "reboot", runs: [] }] }), /Unknown device scenario/);
});
