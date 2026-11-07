import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { collectPage, describeState, measureFirstFrame, peerStats, receiverTimedOut, senderNeverPublished, tileState } from "./tile-diagnostics.mjs";

const track = { readyState: "live", muted: true };

function stageTile(video) {
  const tile = { querySelector: () => video };
  return { querySelector: () => ({ closest: () => tile }) };
}

// A page that runs the same serialized functions Playwright would send to the browser, and returns plain JSON as it does.
function fakePage(globals) {
  return { evaluate: async (fn, arg) => JSON.parse(JSON.stringify(await runInNewContext(`(${fn.toString()})(${JSON.stringify(arg)})`, globals))) };
}

const emptyVideo = { readyState: 0, videoWidth: 0, srcObject: { getVideoTracks: () => [track] }, getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }) };

test("an empty tile reports whether a track arrived, instead of a bare zero", async () => {
  const withTrack = await fakePage({ document: stageTile(emptyVideo) }).evaluate(tileState, "Verify A");
  assert.deepEqual(withTrack, { tile: true, video: true, frames: 0, readyState: 0, width: 0, track });
  assert.equal(describeState(withTrack), "readyState 0, width 0, track live, muted");

  const noTrack = await fakePage({ document: stageTile({ ...emptyVideo, srcObject: null }) }).evaluate(tileState, "Verify A");
  assert.equal(noTrack.track, null);
  assert.match(describeState(noTrack), /no video track attached/);

  const noTile = await fakePage({ document: { querySelector: () => null } }).evaluate(tileState, "Verify A");
  assert.equal(describeState(noTile), "no tile on the page");
});

test("a decoding tile reports its frames", async () => {
  const video = { ...emptyVideo, readyState: 4, videoWidth: 640, getVideoPlaybackQuality: () => ({ totalVideoFrames: 42 }) };
  assert.equal((await fakePage({ document: stageTile(video) }).evaluate(tileState, "Verify B")).frames, 42);
});

test("a tile that stays empty is a measured timeout with no first frame, and the messages tell the two failures apart", async () => {
  const page = fakePage({ document: stageTile(emptyVideo) });
  const measured = await measureFirstFrame(page, "Verify A", { timeoutMs: 60, pollMs: 10 });
  assert.equal(measured.firstFrameMs, null);
  assert.equal(measured.state.track.readyState, "live");
  assert.equal(receiverTimedOut("Verify B", "Verify A", measured, 60_000), "60 s timeout: Verify A's tile on Verify B's page decoded 0 frames (readyState 0, width 0, track live, muted)");
  assert.match(senderNeverPublished("Verify A", measured, 60_000), /^sender never published: Verify A's own tile decoded 0 frames in 60 s/);
});

test("a tile that starts decoding reports when the first frame came", async () => {
  let polls = 0;
  const video = { ...emptyVideo, readyState: 4, videoWidth: 640, getVideoPlaybackQuality: () => ({ totalVideoFrames: ++polls > 2 ? 9 : 0 }) };
  const measured = await measureFirstFrame(fakePage({ document: stageTile(video) }), "Verify A", { timeoutMs: 1000, pollMs: 10 });
  assert.equal(measured.state.frames, 9);
  assert.ok(measured.firstFrameMs >= 20 && measured.firstFrameMs < 1000);
});

const statsRows = [
  { id: "t", type: "transport", dtlsState: "connected", iceState: "connected", selectedCandidatePairId: "p", bytesSent: 10, bytesReceived: 20 },
  { id: "p", type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.02, localCandidateId: "l", remoteCandidateId: "r" },
  { id: "l", type: "local-candidate", candidateType: "host", address: "10.0.0.1" },
  { id: "r", type: "remote-candidate", candidateType: "srflx", address: "203.0.113.9" },
  { id: "i", type: "inbound-rtp", kind: "video", packetsReceived: 0, bytesReceived: 0, framesDecoded: 0, keyFramesDecoded: 0, pliCount: 3, firCount: 0, nackCount: 1, freezeCount: 0 },
  { id: "ia", type: "inbound-rtp", kind: "audio", packetsReceived: 500 },
  { id: "o", type: "outbound-rtp", kind: "video", packetsSent: 80, bytesSent: 9000, framesEncoded: 30 },
];

test("peer stats keep video counters and candidate types and drop addresses and audio", async () => {
  const connection = { connectionState: "connected", iceConnectionState: "connected", signalingState: "stable", getStats: async () => new Map(statsRows.map((row) => [row.id, row])) };
  const [summary] = await fakePage({ window: { proofConnections: [connection] } }).evaluate(peerStats);
  assert.equal(summary.selectedPair.localType, "host");
  assert.equal(summary.selectedPair.remoteType, "srflx");
  assert.deepEqual(summary.inboundVideo, [{ packetsReceived: 0, bytesReceived: 0, framesDecoded: 0, keyFramesDecoded: 0, pliCount: 3, firCount: 0, nackCount: 1, freezeCount: 0 }]);
  assert.deepEqual(summary.outboundVideo, [{ packetsSent: 80, bytesSent: 9000, framesEncoded: 30 }]);
  assert.equal(JSON.stringify(summary).includes("203.0.113.9"), false);
});

test("the page dump carries stats, console errors and failed requests, and survives a page that cannot answer", async () => {
  const logs = {
    console: [
      { who: "Verify B", type: "error", text: "boom" },
      { who: "Verify B", type: "log", text: "fine" },
      { who: "Verify A", type: "pageerror", text: "other page" },
    ],
    network: [
      { who: "Verify B", method: "GET", path: "/v1/ok", status: 200 },
      { who: "Verify B", method: "POST", path: "/v1/join", status: 502, errorCode: "sfu.unavailable" },
      { who: "Verify B", method: "POST", path: "/v1/other", error: "net::ERR_ABORTED" },
    ],
  };
  const live = { name: "Verify B", page: fakePage({ document: stageTile(emptyVideo), window: { proofConnections: [] } }) };
  const dump = await collectPage(live, { tileNames: ["Verify A", "Verify B"], logs, measurements: { "Verify B": { remoteFirstFrameMs: null } } });
  assert.deepEqual(dump.firstFrameMs, { remoteFirstFrameMs: null });
  assert.equal(dump.tiles["Verify A"].frames, 0);
  assert.deepEqual(dump.peers, []);
  assert.deepEqual(dump.consoleErrors, [logs.console[0]]);
  assert.deepEqual(dump.failedRequests, [logs.network[1], logs.network[2]]);

  const closed = {
    name: "Verify A",
    page: {
      evaluate: async () => {
        throw new Error("Target closed");
      },
    },
  };
  const gone = await collectPage(closed, { tileNames: ["Verify A"], logs, measurements: {} });
  assert.deepEqual(gone.peers, { unavailable: "Target closed" });
});
