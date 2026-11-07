import { WHOLE_CYCLE } from "../schema.mjs";
import { metric, passMetric } from "../stats.mjs";

// TestAPublisherThatSendsRTXUnderItsRIDCannotHangShutdown is skipped unconditionally, so it is not listed.
const IMPAIRMENT_TESTS = [
  "TestOneConstrainedSubscriberAdaptsAlone",
  "TestVideoOnlySubscriberResumesAfterStarvation",
  "TestLossOnEachLegIsRepairedOverRTX",
  "TestTenPersonCallWithAScreenShareStaysUnderTheEpisodeCeiling",
  "TestImpairedCallsLogNothingForbidden",
];

const jsonLines = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

/**
 * goTestMetrics maps `go test -json` output of features/media/sfu/tests to pass rates for the
 * loopback test (real HTTP and real Pion peers) and the impaired-network tests. A skipped test is not counted.
 */
export function goTestMetrics(text) {
  const outcomes = new Map();
  for (const event of jsonLines(text)) {
    if (event.Test && ["pass", "fail"].includes(event.Action)) outcomes.set(event.Test, event.Action === "pass");
  }
  const source = "sfu-go-test";
  const metrics = [];
  const dropped = [];
  const loopback = outcomes.has("TestLoopback") ? [outcomes.get("TestLoopback")] : [];
  const impairment = IMPAIRMENT_TESTS.filter((name) => outcomes.has(name)).map((name) => outcomes.get(name));
  for (const [id, results, expected] of [
    ["sfu.loopback.pass", loopback, 1],
    ["sfu.impairment.pass", impairment, IMPAIRMENT_TESTS.length],
  ]) {
    metrics.push(passMetric(id, results, source));
    if (results.length < expected) dropped.push({ metric: id, reason: "test_not_run", count: expected - results.length });
  }
  return { metrics, dropped };
}

/**
 * liveSampleMetrics maps the JSON lines the live smoke test appends to SFU_LIVE_SAMPLES (one sample a minute)
 * to loss, stalls and admission refusals. The node does not report CPU busy, packet rates or egress in a sample;
 * nodeLoadMetrics reads those.
 */
export function liveSampleMetrics(text) {
  const samples = jsonLines(text).filter((sample) => sample.ready && sample.classes > 0);
  const source = "sfu-live-smoke";
  if (samples.length === 0) return { metrics: [], dropped: [{ metric: WHOLE_CYCLE, reason: "no_samples", count: 1 }] };
  const metrics = [];
  const dropped = [];
  const loss = samples.filter((sample) => sample.peers.expected > 0).map((sample) => (100 * (sample.peers.expected - sample.peers.received)) / sample.peers.expected);
  metrics.push(metric("sfu.loss_pct", loss, source));
  metrics.push(metric("sfu.admission_refusals", [samples.filter((sample) => sample.ready.host.admissionReason || sample.refused).length], source));
  const last = samples.at(-1);
  const hours = (Date.parse(last.at) - Date.parse(samples[0].at)) / 3_600_000;
  const classes = Math.max(...samples.map((sample) => sample.classes));
  if (hours > 0) {
    const stalls = last.peers.videoStalls + last.peers.screenStalls + last.peers.audioStalls;
    metrics.push(metric("sfu.stalls_per_class_hour", [stalls / (classes * hours)], source));
  } else dropped.push({ metric: "sfu.stalls_per_class_hour", reason: "run_too_short", count: 1 });
  return { metrics, dropped };
}

/**
 * nodeLoadMetrics maps a node load summary: one entry per sample with the classes held and what the
 * node and its telemetry reported. Documented in README.md, written by the load harness.
 */
export function nodeLoadMetrics(summary) {
  const source = "sfu-node-load";
  const samples = summary.samples.filter((sample) => sample.classes > 0);
  const perClass = (id, pick) =>
    metric(
      id,
      samples.map((sample) => pick(sample) / sample.classes),
      source,
    );
  return {
    metrics: [
      perClass("sfu.cpu_work_pct_per_class", (sample) => Math.max(0, sample.cpuBusyPercent - (sample.stealPercent ?? 0))),
      perClass("sfu.pps_in_per_class", (sample) => sample.ppsIn),
      perClass("sfu.pps_out_per_class", (sample) => sample.ppsOut),
      perClass("sfu.egress_mbit_s_per_class", (sample) => sample.egressMbitPerSecond),
      metric(
        "sfu.freeze_ms_per_minute",
        samples.map((sample) => sample.freezeMsPerMinute),
        source,
      ),
    ],
    dropped: [],
  };
}
