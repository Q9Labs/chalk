import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { installLatencyProbe } from "./latency-probe.mjs";

const clock = () => performance.timeOrigin + performance.now();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Drives the real probe against a fake page: one remote microphone track and its inbound-rtp rows, which the test changes while the watch runs.
function pageWith(track, packets, { rows = [track.id] } = {}) {
  const remote = [{ participantId: "p1", source: "microphone", track }];
  globalThis.window = {
    proofClient: { getSnapshot: () => ({ media: { remote }, participants: { roster: [] } }), media: { setMicrophoneEnabled: async () => {} } },
    proofConnections: [
      {
        connectionState: "connected",
        getStats: async () => new Map(rows.map((trackIdentifier, index) => [`rtp${index}`, { type: "inbound-rtp", id: `rtp${index}`, kind: "audio", trackIdentifier, packetsReceived: packets.count }])),
      },
    ],
  };
  installLatencyProbe();
  return async (timeoutMs) => {
    await window.proofLatency.arm("w", [{ name: "silenced", kind: "silenced", participantId: "p1", source: "microphone" }], timeoutMs);
    return (await window.proofLatency.result("w"))[0];
  };
}

afterEach(() => {
  delete globalThis.window;
});

test("a disabled microphone track whose packets stop is silenced from its last packet, after the quiet window", async () => {
  const track = { id: "t1", readyState: "live", enabled: true, muted: false };
  const packets = { count: 10 };
  const watch = pageWith(track, packets);
  const watching = watch(3000);
  await pause(50);
  track.enabled = false;
  await pause(30);
  packets.count = 12;
  const lastPacketAt = clock();
  const seen = await watching;
  assert.ok(seen.at >= lastPacketAt, `silence cannot begin before the last packet (${seen.at - lastPacketAt} ms)`);
  assert.ok(seen.at - lastPacketAt < 200, `silence begins at the last packet, not at the end of the quiet window (${seen.at - lastPacketAt} ms)`);
  assert.ok(clock() - lastPacketAt >= 600, "the watch waited out the quiet window");
});

test("a disabled microphone track that still gets a packet every 400 ms (DTX) is never silenced", async () => {
  const track = { id: "t1", readyState: "live", enabled: false, muted: false };
  const packets = { count: 0 };
  const watch = pageWith(track, packets);
  const feed = setInterval(() => (packets.count += 1), 400);
  try {
    assert.equal((await watch(2000)).at, null);
  } finally {
    clearInterval(feed);
  }
});

test("a disabled microphone track still receiving audio packets is never silenced", async () => {
  const track = { id: "t1", readyState: "live", enabled: false, muted: false };
  const packets = { count: 0 };
  const watch = pageWith(track, packets);
  const feed = setInterval(() => (packets.count += 1), 20);
  try {
    assert.equal((await watch(1000)).at, null);
  } finally {
    clearInterval(feed);
  }
});

test("an enabled microphone track is never silenced, muted or not", async () => {
  const track = { id: "t1", readyState: "live", enabled: true, muted: true };
  const watch = pageWith(track, { count: 5 });
  assert.equal((await watch(900)).at, null);
});

test("without inbound counters for the microphone track, silence is unproved", async () => {
  const track = { id: "t1", readyState: "live", enabled: false, muted: false };
  const watch = pageWith(track, { count: 5 }, { rows: ["another-track"] });
  assert.equal((await watch(900)).at, null);
});

test("silence that held before the action is timed from the action", async () => {
  const track = { id: "t1", readyState: "live", enabled: false, muted: false };
  const watch = pageWith(track, { count: 5 });
  const watching = watch(3000);
  await pause(100);
  const { at: actionAt } = await window.proofLatency.act("microphone", false);
  const seen = await watching;
  assert.ok(seen.at >= actionAt, `a duration measured from the action is never negative (${seen.at - actionAt} ms)`);
});

test("an ended microphone track is silenced at once", async () => {
  const track = { id: "t1", readyState: "ended", enabled: true, muted: false };
  const watch = pageWith(track, { count: 5 });
  assert.notEqual((await watch(2000)).at, null);
});
