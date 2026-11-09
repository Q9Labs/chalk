import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { STAGE_GROUPS } from "../../features/scorecard/stages.mjs";
import { SCORECARD_SCHEMA, parseScorecard } from "../../features/scorecard/schema.mjs";
import { diagnosticsOf, joinStages, toggleStages } from "./latency-stages.mjs";
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
  const run = { id: "run-1", commit: "a".repeat(40), tier: "manual", environment: "ci", startedAt: "2026-11-08T00:00:00.000Z", client: { kind: "browser", browser: "chromium/151", region: "github-hosted", size: "ubuntu-24-04" } };
  assert.doesNotThrow(() => parseScorecard({ schema: SCORECARD_SCHEMA, run, mediaPlane: "chalk_sfu", metrics: [], dropped: [], diagnostics: found }));
});

// The page trace runs against fakes: it must record frames, replies and connection state, measure a ping's round trip,
// and still pass every frame and request through unchanged.
test("the page trace records wire events, measures the Sync ping and leaves traffic untouched", async () => {
  const saved = { window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, RTCPeerConnection: globalThis.RTCPeerConnection, proofConnections: globalThis.proofConnections };
  const sent = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send(data) {
      sent.push(data);
      if (JSON.parse(data).type === "ping") setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: '{"type":"pong"}' })), 20);
    }
  }
  class FakePeer extends EventTarget {
    connectionState = "new";
    async getStats() {
      const rows = new Map([
        ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { type: "candidate-pair", currentRoundTripTime: 0.205 }],
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
    const rtt = await globalThis.proofTrace.syncRtt();
    assert.ok(rtt >= 15 && rtt < 200, `ping round trip ${rtt}`);
    assert.equal(sent.filter((data) => data === '{"type":"ping"}').length, 3);
  } finally {
    await sleep(0);
    Object.assign(globalThis, saved);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key];
    delete globalThis.proofTrace;
  }
});
