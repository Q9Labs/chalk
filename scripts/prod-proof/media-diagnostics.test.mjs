import assert from "node:assert/strict";
import test from "node:test";
import { signalingOperation, installTransportDiagnostics, browserStats } from "./media.mjs";

test("signaling diagnostics retain the operation without route identifiers or tokens", () => {
  assert.equal(signalingOperation("https://example.invalid/v1/tenants/private/spaces/private/episodes/private/participants/private/media/sfu/tracks/close?credential=private"), "tracks/close");
  assert.equal(signalingOperation("https://example.invalid/v1/private/access-grant"), "access-grant");
  assert.equal(signalingOperation("https://example.invalid/private"), null);
});

test("peer and DTLS transitions and RTP counters are timestamped without SDP or addresses", async (t) => {
  const dtls = new EventTarget();
  dtls.state = "connecting";
  const rows = [
    { id: "rtp", type: "inbound-rtp", kind: "audio", trackIdentifier: "remote-track", packetsReceived: 7, bytesReceived: 200 },
    { id: "outbound", type: "outbound-rtp", kind: "audio", packetsSent: 9, bytesSent: 300 },
    { id: "transport", type: "transport", dtlsState: "connected", localCertificateId: "private", selectedCandidatePairId: "private" },
    { id: "candidate", type: "local-candidate", address: "private-address" },
  ];
  class Peer extends EventTarget {
    signalingState = "stable";
    iceConnectionState = "connected";
    connectionState = "connected";
    constructor() {
      super();
      window.proofConnections.push(this);
    }
    getTransceivers() {
      return [{ sender: { transport: dtls }, mid: "0" }];
    }
    async getStats() {
      return new Map(rows.map((row) => [row.id, row]));
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = { RTCPeerConnection: Peer, proofConnections: [], proofClient: { getSnapshot: () => ({ media: { screenShare: {}, remote: [{ source: "microphone", track: { id: "remote-track" } }] } }) } };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  });
  installTransportDiagnostics();
  const peer = new window.RTCPeerConnection();
  peer.iceConnectionState = "disconnected";
  peer.dispatchEvent(new Event("iceconnectionstatechange"));
  dtls.state = "connected";
  dtls.dispatchEvent(new Event("statechange"));
  const evidence = await browserStats();
  assert.ok(evidence.every((row) => Number.isFinite(Date.parse(row.at))));
  assert.ok(evidence.some((row) => row.type === "peer-state" && row.iceConnectionState === "disconnected"));
  assert.ok(evidence.some((row) => row.type === "dtls-state" && row.state === "connected"));
  assert.ok(evidence.some((row) => row.type === "inbound-rtp" && row.packetsReceived === 7));
  assert.ok(evidence.some((row) => row.type === "outbound-rtp" && row.packetsSent === 9));
  assert.ok(evidence.some((row) => row.type === "transport" && row.dtlsState === "connected"));
  assert.doesNotMatch(JSON.stringify(evidence), /private|certificate|candidate/i);
});
