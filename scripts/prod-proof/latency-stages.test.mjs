import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { AUDIO_KEYS, STAGE_GROUPS } from "../../features/scorecard/stages.mjs";
import { problemOf, DIAGNOSTICS_SCHEMA } from "../../features/scorecard/diagnostics.mjs";
import { audioPath, diagnosticsOf, joinStages, syncRoundTrip, toggleStages } from "./latency-stages.mjs";
import { diagnosticsFile, scorecard } from "./latency-card.mjs";
import { summarize } from "./latency-stats.mjs";
import { METRICS } from "../../features/scorecard/schema.mjs";
import { installLatencyTrace } from "./latency-trace.mjs";

const at = (t, k, d) => ({ t, k, d });
const command = "live_target:set_microphone_enabled:true";
const sender = [at(1040, "ws_out", command), at(1250, "ws_in", "live_target_result"), at(1300, "http_end", "POST tracks")];
const receiver = [at(1150, "ws_in", "projection_event:media"), at(1380, "http_end", "GET publications"), at(1500, "http_end", "POST tracks"), at(1560, "http_end", "PUT renegotiate")];
const trace = { t0: 1000, sender, receiver, command, visibleAt: 1160, finalAt: 1700 };

test("a microphone turn-on splits into stages that add up to the media delay", () => {
  const stages = toggleStages("mic_on", trace);
  assert.deepEqual(stages, {
    "mic_on.prepare": 40,
    "mic_on.sync_fanout": 110,
    "mic_on.roster_apply": 10,
    "mic_on.list_publications": 220,
    "mic_on.pull": 120,
    "mic_on.renegotiate": 60,
    "mic_on.first_media": 140,
    "mic_on.sync_ack": 250,
    "mic_on.sfu_publish": 300,
  });
  const chain = ["prepare", "sync_fanout", "roster_apply", "list_publications", "pull", "renegotiate", "first_media"];
  assert.equal(
    chain.reduce((sum, name) => sum + stages[`mic_on.${name}`], 0),
    trace.finalAt - trace.t0,
  );
});

test("a stage the SDK skipped is null and its time moves to the next stage reached", () => {
  const stages = toggleStages("mic_on", { ...trace, receiver: receiver.filter((event) => event.d !== "GET publications") });
  assert.equal(stages["mic_on.list_publications"], null);
  assert.equal(stages["mic_on.pull"], 340);
});

test("a timeout leaves the stages it never reached null, and an unsent command leaves the chain null", () => {
  const timedOut = toggleStages("mic_on", { ...trace, finalAt: null });
  assert.equal(timedOut["mic_on.first_media"], null);
  assert.equal(timedOut["mic_on.pull"], 120);
  const unsent = toggleStages("mic_on", { ...trace, sender: [] });
  assert.equal(unsent["mic_on.prepare"], null);
  assert.equal(unsent["mic_on.sync_fanout"], null);
  assert.equal(unsent["mic_on.sync_ack"], null);
});

test("a roster frame stamped just before the send, from the other page's clock, counts as zero rather than negative", () => {
  const skewed = toggleStages("mic_on", { ...trace, receiver: [at(1039.5, "ws_in", "projection_event:media"), ...receiver.slice(1)] });
  assert.equal(skewed["mic_on.sync_fanout"], 0);
});

test("a turn-off uses the close stages", () => {
  const off = toggleStages("camera_off", {
    t0: 1000,
    command: "live_target:set_camera_enabled:false",
    visibleAt: 1100,
    finalAt: 1400,
    sender: [at(1020, "ws_out", "live_target:set_camera_enabled:false"), at(1090, "http_end", "PUT tracks/close")],
    receiver: [at(1090, "ws_in", "projection_event:media"), at(1250, "http_end", "PUT tracks/close")],
  });
  assert.equal(off["camera_off.close_tracks"], 150);
  assert.equal(off["camera_off.track_removed"], 150);
  assert.equal(off["camera_off.sfu_close"], 90);
});

test("join splits the Sync connect and notes the SFU steps from the call", () => {
  const events = [at(1010, "ws_new"), at(1100, "ws_open"), at(1300, "ws_in", "welcome"), at(1350, "ws_in", "entered_ack"), at(1400, "http_end", "GET publications"), at(1700, "ice_connected"), at(1800, "http_end", "POST tracks"), at(1900, "http_end", "PUT renegotiate")];
  assert.deepEqual(joinStages({ t0: 1000, events }), {
    "join.prepare": 10,
    "join.sync_connect": 90,
    "join.sync_welcome": 200,
    "join.sync_entered": 50,
    "join.sfu_publications": 400,
    "join.sfu_tracks": 800,
    "join.sfu_renegotiate": 900,
    "join.ice_connected": 700,
  });
});

test("the kit records exactly the stages the registry lists", () => {
  for (const group of STAGE_GROUPS.filter((entry) => entry.id !== "join")) {
    assert.deepEqual(Object.keys(toggleStages(group.id, trace)).sort(), group.stages.map((stage) => `${group.id}.${stage.id}`).sort(), group.id);
  }
  const join = STAGE_GROUPS.find((entry) => entry.id === "join");
  assert.deepEqual(Object.keys(joinStages({ t0: 0, events: [] })).sort(), join.stages.map((stage) => `join.${stage.id}`).sort());
});

test("diagnostics are the percentiles of the traced cycles, and absent without a trace", () => {
  assert.equal(diagnosticsOf([{}]), undefined);
  const cycles = [100, 200, 300, 400].map((ms) => ({ trace: { rtt: { sfu_ms: ms, sync_ms: null }, stages: { "mic_on.prepare": ms / 10 } } }));
  const found = diagnosticsOf(cycles);
  assert.deepEqual(found.rtt, { sfu_ms: { n: 4, p50: 200, p95: 400 }, sync_ms: { n: 0, p50: null, p95: null } });
  assert.deepEqual(found.stages, { "mic_on.prepare": { n: 4, p50: 20, p95: 40 } });
  assert.equal(problemOf({ schema: DIAGNOSTICS_SCHEMA, plane: "chalk_sfu", cycles: [], summary: found }), undefined);
});

test("the Sync round trip pairs the SDK's own pings and pongs and invents none", () => {
  const ping = (t) => at(t, "ws_out", "ping");
  const pong = (t) => at(t, "ws_in", "pong");
  assert.equal(syncRoundTrip([]), null);
  assert.equal(syncRoundTrip([ping(100)]), null, "an unanswered ping gives no round trip");
  assert.equal(syncRoundTrip([pong(100)]), null, "a pong with no ping in flight pairs with nothing");
  assert.equal(syncRoundTrip([ping(100), pong(150), ping(1000), pong(1090), ping(2000), pong(2200)]), 90);
  // The first pong answers the oldest ping, like the SDK's link watch, so a lost pong makes later round trips longer, never shorter.
  assert.equal(syncRoundTrip([ping(100), ping(1000), pong(1050)]), 950);
  // A new socket forgets the pings of the old one.
  assert.equal(syncRoundTrip([ping(100), at(500, "ws_new"), ping(1000), pong(1040)]), 40);
});

// The page trace runs against fakes: it must record frames, replies and connection state, send nothing of its own, and still
// pass every frame and request through unchanged. A frame the trace sent would be one the SDK's pong handler could not tell
// from its own, so the test counts every frame that reaches the socket.
test("the page trace records wire events, sends no frame of its own and leaves traffic untouched", async () => {
  const saved = { window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, RTCPeerConnection: globalThis.RTCPeerConnection, proofConnections: globalThis.proofConnections };
  const sent = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send(data) {
      sent.push(data);
    }
  }
  class FakePeer extends EventTarget {
    connectionState = "new";
    async getStats() {
      const rows = new Map([
        ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { type: "candidate-pair", currentRoundTripTime: 0.205 }],
        ["audio", { type: "inbound-rtp", kind: "audio", jitterBufferEmittedCount: 100, jitterBufferDelay: 4, totalSamplesCount: 4800, totalPlayoutDelay: 24 }],
        ["video", { type: "inbound-rtp", kind: "video", jitterBufferEmittedCount: 7, jitterBufferDelay: 9 }],
      ]);
      return rows;
    }
  }
  const fetched = [];
  globalThis.window = globalThis;
  globalThis.WebSocket = FakeSocket;
  globalThis.RTCPeerConnection = FakePeer;
  globalThis.fetch = async (input, init) => {
    fetched.push([input, init]);
    return { ok: true };
  };
  try {
    installLatencyTrace();
    const socket = new globalThis.WebSocket("wss://sync.invalid");
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "welcome" }) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "projection_event", stream: "media" }) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "projection_event", stream: "whiteboard" }) }));
    socket.dispatchEvent(new MessageEvent("message", { data: "not json" }));
    socket.send(JSON.stringify({ type: "live_target", name: "set_microphone_enabled", enabled: true }));
    await globalThis.fetch("https://api.invalid/v1/tenants/t/media/sfu/tracks?replacement_cause=x", { method: "POST" });
    await globalThis.fetch("https://api.invalid/v1/tenants/t/media/sfu/publications");
    await globalThis.fetch("https://api.invalid/v1/other");
    const peer = new globalThis.RTCPeerConnection();
    peer.connectionState = "connected";
    peer.dispatchEvent(new Event("connectionstatechange"));
    globalThis.proofConnections = [peer];

    const labels = globalThis.proofTrace.take(0).map((event) => `${event.k} ${event.d ?? ""}`.trim());
    assert.deepEqual(labels, [
      "ws_new",
      "ws_open",
      "ws_in welcome",
      "ws_in projection_event:media",
      "ws_in projection_event:whiteboard",
      "ws_out live_target:set_microphone_enabled:true",
      "http_start POST tracks",
      "http_end POST tracks",
      "http_start GET publications",
      "http_end GET publications",
      "ice_connected",
    ]);
    assert.equal(fetched.length, 3);
    assert.equal(sent.length, 1);
    assert.equal(await globalThis.proofTrace.sfuRtt(), 205);
    assert.deepEqual(await globalThis.proofTrace.audioStats(), { emitted: 100, jitterBufferDelay: 4, samples: 4800, playoutDelay: 24, playoutReported: true }, "audio rows only");
    // The SDK pings and its pong is dropped: the trace has nothing to answer it with, sends nothing, and reads no round trip.
    socket.send('{"type":"ping"}');
    await sleep(50);
    assert.equal(sent.length, 2, "only the page's own frames reached the socket");
    assert.equal(globalThis.proofTrace.syncRtt, undefined, "the trace has no Sync probe");
    assert.equal(syncRoundTrip(globalThis.proofTrace.take(0)), null);
  } finally {
    await sleep(0);
    Object.assign(globalThis, saved);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key];
    delete globalThis.proofTrace;
  }
});

const counters = (emitted, jitterBufferDelay, samples, playoutDelay) => ({ emitted, jitterBufferDelay, samples, playoutDelay, playoutReported: true });

test("the one-way estimate is network time plus jitter buffer, and playout is reported beside it", () => {
  const found = audioPath(counters(1000, 10, 48000, 100), counters(1100, 12.2, 52800, 1060), { sender: 40, receiver: 60 });
  // jitter buffer: 2.2 s over 100 samples = 22 ms; network: (40 + 60) / 2 = 50 ms; playout: 960 s*samples over 4800 samples = 200 ms.
  assert.deepEqual(found, { "media.network_jitter_one_way_ms": 72, "media.network_ms": 50, "media.jitter_buffer_ms": 22, "media.playout_ms": 200 });
  assert.deepEqual(Object.keys(found), AUDIO_KEYS);
});

test("an estimate the window cannot show is null, and one side's round trip stands in for a missing one", () => {
  const still = counters(1000, 10, 48000, 100);
  assert.deepEqual(audioPath(still, still, { sender: 40, receiver: 60 }), { "media.network_jitter_one_way_ms": null, "media.network_ms": 50, "media.jitter_buffer_ms": null, "media.playout_ms": null });
  const later = { ...counters(1100, 12.2, 52800, 1060), playoutReported: false };
  assert.equal(audioPath(still, later, { sender: 40, receiver: null })["media.network_ms"], 40);
  assert.equal(audioPath(still, later, { sender: 40, receiver: null })["media.playout_ms"], null);
  assert.equal(audioPath(still, later, { sender: null, receiver: null })["media.network_jitter_one_way_ms"], null);
  assert.equal(audioPath(counters(1100, 12.2, 1, 1), counters(1200, 12, 2, 2), { sender: 40, receiver: 60 })["media.network_jitter_one_way_ms"], null, "a counter that went backwards is not a delay");
});

test("the sidecar summarizes the audio parts and omits them when no cycle measured any", () => {
  const trace = (audio) => ({ rtt: { sfu_ms: 1, sync_ms: 1 }, stages: {}, ...(audio ? { audio } : {}) });
  assert.equal(diagnosticsOf([{ trace: trace() }]).audio, undefined);
  const cycles = [60, 70, 80, 90].map((ms) => ({ trace: trace({ "media.network_jitter_one_way_ms": ms }) }));
  const found = diagnosticsOf(cycles);
  assert.deepEqual(found.audio["media.network_jitter_one_way_ms"], { n: 4, p50: 70, p95: 90 });
  assert.equal(problemOf({ schema: DIAGNOSTICS_SCHEMA, plane: "chalk_sfu", cycles: [], summary: found }), undefined);
});

// The card is built from the gated metric ids only, so the audio estimate cannot reach it: the same cycles with and without the
// estimate produce the same card, byte for byte, and the estimate shows up only in the sidecar.
test("the card bytes are identical with and without the one-way estimate", () => {
  const sample = Object.fromEntries(Object.keys(METRICS).map((id) => [id, 100]));
  const cycle = (index, audio) => ({ plane: "chalk_sfu", timestamp: `2026-11-08T00:00:0${index}.000Z`, sample, trace: { rtt: { sfu_ms: 40, sync_ms: 20 }, stages: {}, ...(audio ? { audio } : {}) } });
  const build = (audio) => {
    const cycles = [1, 2, 3].map((index) => cycle(index, audio));
    const report = { cycles, planes: { chalk_sfu: { summary: summarize(cycles.map((entry) => entry.sample)) } } };
    const run = { id: "nightly-1", commit: "a".repeat(40), tier: "nightly", environment: "staging", startedAt: "2026-11-08T00:00:00.000Z", client: { kind: "browser", browser: "chromium/151", region: "github-hosted", size: "ubuntu-24-04" } };
    return { card: JSON.stringify(scorecard(report, "chalk_sfu", run)), sidecar: diagnosticsFile(report, "chalk_sfu") };
  };
  const without = build(undefined);
  const withEstimate = build({ "media.network_jitter_one_way_ms": 72, "media.network_ms": 50, "media.jitter_buffer_ms": 22, "media.playout_ms": 200 });
  assert.equal(withEstimate.card, without.card);
  assert.equal(withEstimate.card.includes("network_jitter"), false);
  assert.equal(
    Object.keys(METRICS).some((id) => id.startsWith("media.")),
    false,
    "no card metric is named media.*",
  );
  assert.deepEqual(withEstimate.sidecar.summary.audio["media.network_jitter_one_way_ms"], { n: 3, p50: 72, p95: 72 });
  assert.equal(without.sidecar.summary.audio, undefined);
});
