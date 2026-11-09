import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { DIAGNOSTICS_SCHEMA, diagnosticsMarkdown, problemOf } from "../../features/scorecard/diagnostics.mjs";
import { METRICS } from "../../features/scorecard/schema.mjs";
import { diagnosticsFile, scorecard } from "./latency-card.mjs";
import { icePairOf, iceSummary } from "./latency-ice.mjs";
import { diagnosticsOf } from "./latency-stages.mjs";
import { summarize } from "./latency-stats.mjs";
import { installLatencyTrace } from "./latency-trace.mjs";

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

// Runs installLatencyTrace against fake browser globals, the way the page-trace test in latency-stages.test.mjs does, and hands the
// test the page's peer class and trace.
async function inPage(body) {
  const saved = { window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, RTCPeerConnection: globalThis.RTCPeerConnection, proofConnections: globalThis.proofConnections };
  class FakePeer extends EventTarget {
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
  globalThis.window = globalThis;
  globalThis.WebSocket = class extends EventTarget {};
  globalThis.fetch = async () => ({ ok: true });
  globalThis.RTCPeerConnection = FakePeer;
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    installLatencyTrace();
    await body({ Peer: globalThis.RTCPeerConnection, trace: globalThis.proofTrace });
    await sleep(0);
    assert.deepEqual(rejections, [], "a failed stats read never surfaces as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
    Object.assign(globalThis, saved);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key];
    delete globalThis.proofTrace;
  }
}

const ice = (local_type, remote_type, requests_sent, responses_received) => ({ local_type, remote_type, requests_sent, responses_received });

test("the page trace reads the selected pair when a peer connects, and the join picks the pair of the connection it timed", async () => {
  await inPage(async ({ Peer, trace }) => {
    const first = new Peer(async () => chromeStats({ local: "host", remote: "srflx", requestsSent: 7, responsesReceived: 5 }));
    const second = new Peer(async () => chromeStats({ local: "relay", remote: "host", requestsSent: 2, responsesReceived: 2 }));
    first.connect();
    await sleep(0);
    second.connect();
    await sleep(0);
    const events = trace.take(0);
    assert.deepEqual(
      events.map((event) => event.k),
      ["ice_connected", "ice_pair", "ice_connected", "ice_pair"],
    );
    assert.deepEqual(icePairOf(events, 0), ice("host", "srflx", 7, 5));
    // The second connection is the one a later join timed; the first connection is before its start.
    assert.deepEqual(icePairOf(events, events[2].t), ice("relay", "host", 2, 2));
  });
});

test("a pair without the nominated transport pointer is found by state, and a missing candidate stays null", async () => {
  await inPage(async ({ Peer, trace }) => {
    const stats = chromeStats({ local: "prflx", remote: "relay" });
    stats.delete("RTCTransport_0_1");
    stats.delete("RTCIceCandidate_b2");
    new Peer(async () => stats).connect();
    await sleep(0);
    assert.deepEqual(icePairOf(trace.take(0), 0), ice("prflx", null, 7, 5));
  });
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
  };
  await inPage(async ({ Peer, trace }) => {
    for (const [name, stats] of Object.entries(cases)) {
      const before = trace.take(0).length;
      new Peer(stats).connect();
      await sleep(0);
      const added = trace.take(0).slice(before);
      assert.deepEqual(
        added.map((event) => event.k),
        ["ice_connected"],
        name,
      );
    }
    assert.equal(icePairOf(trace.take(0), 0), null);
  });
  await inPage(async ({ Peer, trace }) => {
    const nonsense = chromeStats({ local: "carrier-pigeon", remote: 7, requestsSent: -3, responsesReceived: "five", pair: { localCandidateId: { id: 1 } } });
    new Peer(async () => nonsense).connect();
    await sleep(0);
    assert.deepEqual(icePairOf(trace.take(0), 0), ice(null, null, null, null));
    assert.equal(
      Object.keys(trace.take(0)[1]).every((key) => ["t", "k", "d"].includes(key)),
      true,
    );
  });
});

test("the join reads no pair when its connection never connected, and ignores malformed events", () => {
  assert.equal(icePairOf([], 0), null);
  assert.equal(icePairOf([{ t: 5, k: "ice_pair", d: JSON.stringify({ since: 5, local: "host", remote: "host" }) }], 0), null, "a pair with no connection event");
  assert.equal(icePairOf([{ t: 5, k: "ice_connected" }], 0), null, "connected, but its pair was not read");
  const connected = { t: 10, k: "ice_connected" };
  for (const d of [undefined, "{broken", "null", "[]", JSON.stringify({ since: 11 }), JSON.stringify({ since: "10" })]) assert.equal(icePairOf([connected, { t: 12, k: "ice_pair", d }], 0), null, String(d));
  assert.equal(
    icePairOf(
      [
        { t: 10, k: "ice_connected" },
        { t: 11, k: "ice_pair", d: "{broken" },
        { t: 12, k: "ice_pair", d: JSON.stringify({ since: 10, local: "host", remote: "host", requestsSent: 1, responsesReceived: 1 }) },
      ],
      0,
    )?.local_type,
    "host",
    "a broken event does not hide a later good one",
  );
  assert.deepEqual(icePairOf([connected, { t: 12, k: "ice_pair", d: JSON.stringify({ since: 10, local: "bogus", requestsSent: 1.5, responsesReceived: null }) }], 0), ice(null, null, null, null));
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
  const cycles = [ice("host", "srflx", 8, 5), ice("host", "srflx", 5, 5), ice("relay", "host", 3, 3)].map((pair) => ({ plane: "chalk_sfu", timestamp: "2026-11-08T00:00:01.000Z", sample: {}, trace: trace(pair) }));
  const report = { cycles, planes: { chalk_sfu: { summary: {} } } };
  const file = diagnosticsFile(report, "chalk_sfu");
  assert.deepEqual(file.cycles[0].ice, ice("host", "srflx", 8, 5));
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
    const run = { id: "nightly-1", commit: "a".repeat(40), tier: "nightly", environment: "staging", startedAt: "2026-11-08T00:00:00.000Z", client: { kind: "browser", browser: "chromium/151", region: "github-hosted", size: "ubuntu-24-04" } };
    return JSON.stringify(scorecard(report, "chalk_sfu", run));
  };
  const withPair = build(ice("relay", "host", 9, 2));
  assert.equal(withPair, build(undefined));
  for (const word of ["relay", "requests_sent", '"ice"']) assert.equal(withPair.includes(word), false, word);
});
