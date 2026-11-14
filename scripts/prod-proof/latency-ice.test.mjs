import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { diagnosticsMarkdown, problemOf } from "../../features/scorecard/diagnostics.mjs";
import { METRICS } from "../../features/scorecard/schema.mjs";
import { diagnosticsFile, scorecard } from "./latency-card.mjs";
import { icePairOf, iceSummary } from "./latency-ice.mjs";
import { diagnosticsOf } from "./latency-stages.mjs";
import { summarize } from "./latency-stats.mjs";

// The kit's page scripts run as init scripts in the guest page, so the tests run their source in a vm context with the clock they choose.
// Values built inside the vm carry its own Array and Object, which deepStrictEqual tells apart from the host's.
const plain = (value) => JSON.parse(JSON.stringify(value));
const pageSource = (name) => readFileSync(new URL(`./${name}.mjs`, import.meta.url), "utf8").replace("export function", "function");

// getStats output shaped like Chromium's: a transport pointing at the selected pair, the pair with its check counters, and one
// local and one remote candidate. Addresses are documentation addresses.
function chromeStats({ local = "host", remote = "srflx", requestsSent = 7, responsesReceived = 5, pair = {} } = {}) {
  return new Map([
    ["RTCTransport_0_1", { id: "RTCTransport_0_1", type: "transport", dtlsState: "connected", selectedCandidatePairId: "RTCIceCandidatePair_a1_b2", bytesSent: 5120 }],
    ["RTCIceCandidate_a1", { id: "RTCIceCandidate_a1", type: "local-candidate", transportId: "RTCTransport_0_1", address: "192.0.2.10", port: 53311, protocol: "udp", candidateType: local, priority: 2122260223 }],
    ["RTCIceCandidate_b2", { id: "RTCIceCandidate_b2", type: "remote-candidate", transportId: "RTCTransport_0_1", address: "198.51.100.7", port: 10042, protocol: "udp", candidateType: remote, priority: 1686052607 }],
    [
      "RTCIceCandidatePair_a1_b2",
      {
        id: "RTCIceCandidatePair_a1_b2",
        type: "candidate-pair",
        transportId: "RTCTransport_0_1",
        localCandidateId: "RTCIceCandidate_a1",
        remoteCandidateId: "RTCIceCandidate_b2",
        state: "succeeded",
        nominated: true,
        requestsSent,
        responsesReceived,
        consentRequestsSent: 0,
        currentRoundTripTime: 0.196,
        ...pair,
      },
    ],
  ]);
}

class Peer extends EventTarget {
  connectionState = "new";
  constructor(stats = async () => chromeStats()) {
    super();
    this.getStats = stats;
  }
  connect() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

// A guest page with the latency trace installed on a clock the test controls.
function pageWith(now = () => 100, extra = {}) {
  const context = vm.createContext({
    WebSocket: class extends EventTarget {},
    RTCPeerConnection: Peer,
    fetch: async () => ({}),
    URL,
    setTimeout,
    clearTimeout,
    performance: { timeOrigin: 0, now },
    PerformanceObserver: class {
      observe() {}
    },
    proofConnections: [],
    ...extra,
  });
  vm.runInContext(`window = globalThis; ${pageSource("latency-trace")}; installLatencyTrace();`, context);
  return context;
}

const ice = (local_type, remote_type, requests_sent, responses_received, read_after_ms = null, protocol = "udp") => ({ local_type, remote_type, protocol, relay_protocol: null, requests_sent, responses_received, read_after_ms });

test("a connecting peer leaves only a marker, and the pair is read later by readIce", async () => {
  let reads = 0;
  const page = pageWith();
  const peer = new page.RTCPeerConnection(async () => {
    reads++;
    return chromeStats({ local: "host", remote: "srflx", requestsSent: 7, responsesReceived: 5 });
  });
  peer.connect();
  assert.equal(reads, 0, "getStats is not called while the connection event is handled");
  assert.deepEqual(
    plain(page.proofTrace.take(0)).map((event) => [event.k, event.peer]),
    [["ice_connected", 1]],
  );
  await page.proofTrace.readIce();
  assert.equal(reads, 1);
  const events = page.proofTrace.take(0);
  assert.deepEqual(
    Array.from(events, (event) => event.k),
    ["ice_connected", "ice_pair"],
  );
  assert.deepEqual(icePairOf(events, 0), ice("host", "srflx", 7, 5, 0));
  await page.proofTrace.readIce();
  assert.equal(reads, 1, "a connection is read once");
});

test("two connections in the same millisecond, the second read answering first, still give each join its own pair", async () => {
  const page = pageWith(() => 100);
  let releaseFirst;
  const first = new page.RTCPeerConnection(() => new Promise((resolve) => (releaseFirst = resolve)));
  const second = new page.RTCPeerConnection(async () => chromeStats({ local: "relay", remote: "host", requestsSent: 2, responsesReceived: 2 }));
  first.connect();
  second.connect();
  const connected = page.proofTrace.take(0);
  assert.equal(connected[0].t, connected[1].t, "both connections share a timestamp");
  assert.notEqual(connected[0].peer, connected[1].peer);

  const reading = page.proofTrace.readIce();
  await sleep(0);
  releaseFirst(chromeStats({ local: "host", remote: "srflx", requestsSent: 7, responsesReceived: 5 }));
  await reading;
  const events = page.proofTrace.take(0);
  assert.deepEqual(icePairOf(events, 0), ice("host", "srflx", 7, 5, 0), "the first connection to connect is the one join.ice_connected times");

  // Whatever order the readings arrive in, a reading belongs to its token, not to the nearest timestamp.
  const marks = events.filter((event) => event.k === "ice_connected");
  const pairs = events.filter((event) => event.k === "ice_pair");
  assert.equal(pairs.length, 2);
  assert.deepEqual(icePairOf([...marks, ...pairs.toReversed()], 0), ice("host", "srflx", 7, 5, 0));
  assert.deepEqual(icePairOf([marks[1], marks[0], ...pairs], 0), ice("relay", "host", 2, 2, 0), "the connection that came first in the trace is the join's, even when it is the second peer created");
});

test("a pair without the nominated transport pointer is found by state, and a missing candidate stays null", async () => {
  const stats = chromeStats({ local: "prflx", remote: "relay" });
  stats.delete("RTCTransport_0_1");
  stats.delete("RTCIceCandidate_b2");
  const page = pageWith();
  new page.RTCPeerConnection(async () => stats).connect();
  await page.proofTrace.readIce();
  assert.deepEqual(icePairOf(page.proofTrace.take(0), 0), ice("prflx", null, 7, 5, 0));
});

test("hostile stats give nulls or no reading, never a throw, and the connection event is still recorded", async () => {
  const cases = {
    "getStats rejects": async () => {
      throw new Error("closed");
    },
    "getStats resolves nothing": async () => undefined,
    "empty report": async () => new Map(),
    "a report whose rows throw": async () => ({
      values() {
        throw new Error("boom");
      },
    }),
    "getStats never resolves": () => new Promise(() => undefined),
  };
  const page = pageWith();
  for (const [name, stats] of Object.entries(cases)) {
    const before = page.proofTrace.take(0).length;
    new page.RTCPeerConnection(stats).connect();
    await page.proofTrace.readIce();
    assert.deepEqual(
      plain(page.proofTrace.take(0))
        .slice(before)
        .map((event) => event.k),
      ["ice_connected"],
      name,
    );
  }
  assert.equal(icePairOf(page.proofTrace.take(0), 0), null);

  const nonsense = pageWith();
  new nonsense.RTCPeerConnection(async () => chromeStats({ local: "carrier-pigeon", remote: 7, requestsSent: -3, responsesReceived: "five", pair: { localCandidateId: { id: 1 } } })).connect();
  await nonsense.proofTrace.readIce();
  assert.deepEqual(icePairOf(nonsense.proofTrace.take(0), 0), ice(null, null, null, null, 0, null));
});

// The measured join must be the same with and without the diagnostic. The judge's synthetic clock advances 5 s inside every getStats call,
// so a stats read anywhere inside the measured interval would turn a ready join into a timeout.
test("the join sample is identical with and without the ICE diagnostic, and the diagnostic reads only afterwards", async () => {
  async function joinSample(traced) {
    let clock = 100;
    let live = false;
    const stats = () => {
      clock += 5000;
      return Promise.resolve(new Map());
    };
    class SlowPeer extends Peer {
      constructor() {
        super(stats);
      }
    }
    const snapshot = { getSnapshot: () => ({ connection: { status: live ? "live" : "idle" }, media: { local: { camera: { state: "enabled" }, microphone: { state: "enabled" } } } }) };
    const context = vm.createContext({
      WebSocket: class extends EventTarget {},
      RTCPeerConnection: SlowPeer,
      fetch: async () => ({}),
      URL,
      setTimeout,
      clearTimeout,
      performance: { timeOrigin: 0, now: () => clock },
      PerformanceObserver: class {
        observe() {}
      },
      proofConnections: [],
      proofClient: snapshot,
    });
    vm.runInContext("window = globalThis;", context);
    if (traced) vm.runInContext(`${pageSource("latency-trace")}; installLatencyTrace();`, context);
    context.proofJoin = async () => {
      const peer = new context.RTCPeerConnection();
      context.proofConnections.push(peer);
      peer.connect();
      live = true;
    };
    vm.runInContext(`${pageSource("latency-probe")}; installLatencyProbe();`, context);
    await context.proofLatency.arm("join", [{ name: "firstReady", kind: "ready" }], 1000);
    const acted = await context.proofLatency.act("join", {});
    const seen = await context.proofLatency.result("join");
    const clockAtResult = clock;
    if (traced) await context.proofTrace.readIce();
    return { acted, seen, clockAtResult, clockAfterRead: clock };
  }
  const without = await joinSample(false);
  const withDiagnostic = await joinSample(true);
  assert.equal(without.seen[0].at, 100);
  assert.deepEqual(plain(withDiagnostic.seen), plain(without.seen));
  assert.deepEqual(plain(withDiagnostic.acted), plain(without.acted));
  assert.equal(withDiagnostic.clockAtResult, without.clockAtResult, "no stats read happened inside the measured interval");
  assert.equal(withDiagnostic.clockAfterRead, withDiagnostic.clockAtResult + 5000, "the diagnostic read the pair once, after the join");
});

test("the join reads no pair when its connection never connected, and ignores malformed events", () => {
  assert.equal(icePairOf([], 0), null);
  assert.equal(icePairOf([{ t: 5, k: "ice_pair", d: JSON.stringify({ peer: 1, local: "host", remote: "host" }) }], 0), null, "a pair with no connection event");
  assert.equal(icePairOf([{ t: 5, k: "ice_connected", peer: 1 }], 0), null, "connected, but its pair was not read");
  assert.equal(
    icePairOf(
      [
        { t: 5, k: "ice_connected" },
        { t: 6, k: "ice_pair", d: JSON.stringify({ local: "host", remote: "host" }) },
      ],
      0,
    ),
    null,
    "a connection with no token matches no reading",
  );
  const connected = { t: 10, k: "ice_connected", peer: 3 };
  for (const d of [undefined, "{broken", "null", "[]", JSON.stringify({ peer: 4 }), JSON.stringify({ peer: "3" }), JSON.stringify({ since: 10 })]) assert.equal(icePairOf([connected, { t: 12, k: "ice_pair", d }], 0), null, String(d));
  const good = { t: 12, k: "ice_pair", d: JSON.stringify({ peer: 3, local: "host", remote: "host", requestsSent: 1, responsesReceived: 1, readAfterMs: 250 }) };
  assert.deepEqual(icePairOf([connected, { t: 11, k: "ice_pair", d: "{broken" }, good], 0), ice("host", "host", 1, 1, 250, null), "a broken event does not hide a later good one");
  assert.deepEqual(icePairOf([connected, { t: 12, k: "ice_pair", d: JSON.stringify({ peer: 3, local: "bogus", requestsSent: 1.5, responsesReceived: null, readAfterMs: -4 }) }], 0), ice(null, null, null, null, null, null));
});

test("the summary counts pairs by type and gives p50 and p95 of the checks that got no reply", () => {
  assert.equal(iceSummary([]), undefined);
  assert.equal(iceSummary([undefined, undefined]), undefined);
  const found = iceSummary([ice("host", "srflx", 5, 5), ice("host", "srflx", 8, 5), ice("host", "srflx", 9, 5), ice("relay", "host", 3, 3), ice(null, "host", 4, 4), ice("host", "host", null, null), ice("host", "host", 2, 3), undefined]);
  assert.deepEqual(found.pairs, { "host/srflx": 3, "relay/host": 1, unknown: 1, "host/host": 2 });
  // Unanswered: 0, 3, 4, 0, 0 (a pair with no counters or with more replies than requests is left out).
  assert.deepEqual(found.unanswered_checks, { n: 5, p50: 0, p95: 4 });
  assert.deepEqual(iceSummary([ice("host", "host", null, null)]).unanswered_checks, { n: 0, p50: null, p95: null });
});

test("the sidecar carries the ICE pair per cycle and in the summary, and the file stays valid", () => {
  const trace = (pair) => ({ rtt: { sfu_ms: 1, sync_ms: 1 }, stages: {}, ...(pair ? { ice: pair } : {}) });
  assert.equal(diagnosticsOf([{ trace: trace() }]).ice, undefined, "a run with no reading has no ice summary");
  const cycles = [ice("host", "srflx", 8, 5, 410), ice("host", "srflx", 5, 5, 380), ice("relay", "host", 3, 3, 520)].map((pair) => ({ plane: "chalk_sfu", timestamp: "2026-11-08T00:00:01.000Z", sample: {}, trace: trace(pair) }));
  const report = { cycles, planes: { chalk_sfu: { summary: {} } } };
  const file = diagnosticsFile(report, "chalk_sfu");
  assert.deepEqual(file.cycles[0].ice, ice("host", "srflx", 8, 5, 410));
  assert.deepEqual(file.summary.ice, { pairs: { "host/srflx": 2, "relay/host": 1 }, unanswered_checks: { n: 3, p50: 0, p95: 3 } });
  assert.equal(problemOf(file), undefined);
  assert.match(diagnosticsMarkdown(file.summary), /Selected pairs: host\/srflx 2, relay\/host 1\./);
  assert.match(diagnosticsMarkdown(file.summary), /Checks sent without a reply on that pair: 0 \/ 3 \(n=3\)/);
});

// The card is built from the gated metric ids only, so the ICE reading cannot reach it.
test("the card bytes are identical with and without the ICE pair", () => {
  const sample = Object.fromEntries(Object.keys(METRICS).map((id) => [id, 100]));
  const build = (pair) => {
    const cycles = [1, 2, 3].map((index) => ({ plane: "chalk_sfu", timestamp: `2026-11-08T00:00:0${index}.000Z`, sample, trace: { rtt: { sfu_ms: 40, sync_ms: 20 }, stages: {}, ...(pair ? { ice: pair } : {}) } }));
    const report = { cycles, planes: { chalk_sfu: { summary: summarize(cycles.map((entry) => entry.sample)) } } };
    const run = { id: "nightly-1", commit: "a".repeat(40), tier: "nightly", environment: "nightly", startedAt: "2026-11-08T00:00:00.000Z", client: { kind: "browser", browser: "chromium/151", region: "github-hosted", size: "ubuntu-24-04" } };
    return JSON.stringify(scorecard(report, "chalk_sfu", run));
  };
  const withPair = build(ice("relay", "host", 9, 2, 300));
  assert.equal(withPair, build(undefined));
  for (const word of ["relay", "requests_sent", '"ice"', "read_after_ms"]) assert.equal(withPair.includes(word), false, word);
});
