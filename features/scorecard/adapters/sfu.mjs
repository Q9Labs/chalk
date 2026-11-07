import { WHOLE_CYCLE } from "../schema.mjs";
import { metric, passMetric } from "../stats.mjs";

// TestAPublisherThatSendsRTXUnderItsRIDCannotHangShutdown is skipped unconditionally, so it is not listed.
const IMPAIRMENT_TESTS = ["TestOneConstrainedSubscriberAdaptsAlone", "TestVideoOnlySubscriberResumesAfterStarvation", "TestLossOnEachLegIsRepairedOverRTX", "TestTenPersonCallWithAScreenShareStaysUnderTheEpisodeCeiling", "TestImpairedCallsLogNothingForbidden"];

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

// The live smoke test writes Go durations such as "1m0.5s" or "1h2m3s".
function elapsedSeconds(text) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(text ?? "");
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : Number.NaN;
}

/**
 * liveSampleMetrics maps the JSON lines the live smoke test appends to SFU_LIVE_SAMPLES (one sample a minute)
 * to loss, stalls and admission refusals. Counters in a sample are cumulative since the run started, so each
 * sample is turned into the interval since the one before it (the first runs from the start): loss is the
 * interval's lost share of expected packets, and stalls per class-hour divides all stalls by the classes held
 * times the length of each interval. The node does not report CPU busy, packet rates or egress in a sample;
 * nodeLoadMetrics reads those.
 */
export function liveSampleMetrics(text) {
  const samples = jsonLines(text).filter((sample) => sample.ready && sample.classes > 0);
  const source = "sfu-live-smoke";
  if (samples.length === 0) return { metrics: [], dropped: [{ metric: WHOLE_CYCLE, reason: "no_samples", count: 1 }] };
  const metrics = [];
  const dropped = [];
  const loss = [];
  let classHours = 0;
  let previous = { peers: { expected: 0, received: 0 }, seconds: 0 };
  for (const sample of samples) {
    const seconds = elapsedSeconds(sample.elapsed);
    const expected = sample.peers.expected - previous.peers.expected;
    const received = sample.peers.received - previous.peers.received;
    // Late packets that arrive in a later interval can make received outrun expected there, so a recovered interval counts as no loss.
    if (expected > 0) loss.push(Math.max(0, (100 * (expected - received)) / expected));
    if (seconds > previous.seconds) classHours += (sample.classes * (seconds - previous.seconds)) / 3600;
    previous = { peers: sample.peers, seconds: Number.isFinite(seconds) ? seconds : previous.seconds };
  }
  metrics.push(metric("sfu.loss_pct", loss, source));
  metrics.push(metric("sfu.admission_refusals", [samples.filter((sample) => sample.ready.host.admissionReason || sample.refused).length], source));
  if (classHours > 0) {
    const last = samples.at(-1).peers;
    metrics.push(metric("sfu.stalls_per_class_hour", [(last.videoStalls + last.screenStalls + last.audioStalls) / classHours], source));
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
