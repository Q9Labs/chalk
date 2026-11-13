import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { installLatencyProbe } from "./latency-probe.mjs";

// Drives the real probe against a fake page: a remote microphone track whose state the test changes while the watch runs.
function pageWith(track, packets) {
  const remote = [{ participantId: "p1", source: "microphone", track }];
  globalThis.window = {
    proofClient: { getSnapshot: () => ({ media: { remote }, participants: { roster: [] } }) },
    proofConnections: [{ connectionState: "connected", getStats: async () => new Map([["rtp", { type: "inbound-rtp", id: "rtp", kind: "audio", trackIdentifier: track.id, packetsReceived: packets.count }]]) }],
  };
  installLatencyProbe();
  return {
    remote,
    watch: async (timeoutMs) => {
      await window.proofLatency.arm("w", [{ name: "silenced", kind: "silenced", participantId: "p1", source: "microphone" }], timeoutMs);
      return (await window.proofLatency.result("w"))[0];
    },
  };
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
afterEach(() => {
  delete globalThis.window;
});

test("a disabled microphone track that stops receiving packets counts as silenced, timed from the last packet", async () => {
  const track = { id: "t1", readyState: "live", enabled: true, muted: false };
  const packets = { count: 10 };
  const page = pageWith(track, packets);
  const watching = page.watch(3000);
  await pause(50);
  track.enabled = false;
  packets.count = 12;
  await pause(30);
  const lastPacketAt = performance.timeOrigin + performance.now();
  await pause(450);
  const seen = await watching;
  assert.ok(seen.at !== null, "silence was never reported");
  assert.ok(seen.at - lastPacketAt < 150, `silence starts at the last packet, not at the quiet window's end (${seen.at - lastPacketAt} ms)`);
});

test("a disabled microphone track still receiving audio packets never counts as silenced", async () => {
  const track = { id: "t1", readyState: "live", enabled: false, muted: false };
  const packets = { count: 0 };
  const page = pageWith(track, packets);
  const feed = setInterval(() => (packets.count += 1), 20);
  try {
    assert.equal((await page.watch(800)).at, null);
  } finally {
    clearInterval(feed);
  }
});

test("an enabled, unmuted microphone track never counts as silenced, even when no packet arrives", async () => {
  const track = { id: "t1", readyState: "live", enabled: true, muted: false };
  const page = pageWith(track, { count: 5 });
  assert.equal((await page.watch(600)).at, null);
});

test("a muted microphone track with no packets counts as silenced", async () => {
  const track = { id: "t1", readyState: "live", enabled: true, muted: true };
  const page = pageWith(track, { count: 5 });
  assert.notEqual((await page.watch(2000)).at, null);
});

test("an ended microphone track counts as silenced at once", async () => {
  const track = { id: "t1", readyState: "ended", enabled: true, muted: false };
  const page = pageWith(track, { count: 5 });
  assert.notEqual((await page.watch(2000)).at, null);
});
