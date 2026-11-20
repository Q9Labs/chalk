import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindConnectionMediaClient } from "../connection/production";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import type { ConnectionMediaFactoryInput } from "../connection/dependencies";
import { CloudflareSFUClient, CloudflareSFUError } from "./cloudflare-sfu";
import { bootstrap, FakeTrack, FakeTransport, fakeStream, versionedPublicationID } from "./cloudflare-sfu.test.helpers";

const symptom = "join.no_media";
const CONNECTED = { connection: "connected", ice: "connected" } as const;
type TransportState = { readonly connection: RTCPeerConnectionState; readonly ice: RTCIceConnectionState };

class Peer extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  readonly senders: RTCRtpSender[] = [];
  sendPackets: number | undefined;
  receivePackets: number | undefined;
  route: "host" | "relay" = "host";
  answerState: TransportState = CONNECTED;

  change(state: TransportState) {
    this.connectionState = state.connection;
    this.iceConnectionState = state.ice;
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }

  getSenders() {
    return this.senders;
  }
  getReceivers() {
    return [];
  }
  getTransceivers() {
    return [];
  }
  addTransceiver(track: MediaStreamTrack) {
    const sender = { track, replaceTrack: async () => {} };
    this.senders.push(sender as RTCRtpSender);
    return { mid: String(this.senders.length), sender, stop: () => {} };
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\na=group:BUNDLE 1\r\n" };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\n" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  async setRemoteDescription() {
    this.change(this.answerState);
  }
  close() {
    this.change({ connection: "closed", ice: "closed" });
  }

  emitTrack(mid: string, track: FakeTrack) {
    this.dispatchEvent(Object.assign(new Event("track"), { transceiver: { mid }, track }));
  }

  async getStats(): Promise<RTCStatsReport> {
    const rows = new Map<string, RTCStats>();
    const stat = (id: string, type: string, values: object) => rows.set(id, { id, type, timestamp: performance.now(), ...values });
    if (this.connectionState === "connected") {
      stat("transport", "transport", { dtlsState: "connected", selectedCandidatePairId: "pair" });
      stat("pair", "candidate-pair", { state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote" });
      stat("local", "local-candidate", { candidateType: this.route });
      stat("remote", "remote-candidate", { candidateType: "host" });
    }
    if (this.sendPackets !== undefined) stat("send", "outbound-rtp", { kind: "audio", packetsSent: this.sendPackets });
    if (this.receivePackets !== undefined) stat("receive", "inbound-rtp", { kind: "audio", packetsReceived: this.receivePackets });
    return rows;
  }
}

const clients: ReturnType<typeof createSpaceClientForPlatform>[] = [];

function scenario(input: { readonly syncTimeout?: boolean; readonly deviceError?: string; readonly pullFails?: boolean } = {}) {
  const base = createCoreTestPlatform();
  const peer = new Peer();
  const transport = new FakeTransport(() => peer);
  const publication = { participantId: "participant-2", source: "microphone", publicationId: versionedPublicationID("remote", "3", "microphone-remote") } as const;
  transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };
  if (input.pullFails) transport.failRemotePullCount = 100;
  const app = {
    ...base,
    dependencies: {
      ...base.dependencies,
      createSyncClient: () => (input.syncTimeout ? { ...base.sync, start: async () => {} } : base.sync),
      mediaDevices: {
        ...base.dependencies.mediaDevices,
        getUserMedia: async (requested: MediaStreamConstraints) => {
          if (requested.audio && input.deviceError) throw new DOMException("a private label", input.deviceError);
          return requested.audio ? fakeStream(new FakeTrack("mic", "audio")) : fakeStream();
        },
      },
      createMediaClient: (options: ConnectionMediaFactoryInput) => {
        const media = new CloudflareSFUClient({
          bootstrap: bootstrap("connection-1"),
          participantId: "participant-1",
          peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
          pollIntervalMs: 500,
          transport,
          initialJoin: options.initialJoin,
        });
        return bindConnectionMediaClient(media, async () => {});
      },
    },
  };
  const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, app);
  clients.push(client);
  const signals = async () => {
    await base.outbox.outbox.flush();
    const events = base.outbox.accepted.filter((event) => event.type === "initial_join");
    expect(new Set(events.map((event) => event.op_id)).size).toBe(1);
    expect(events.every((event) => event.event_id !== undefined)).toBe(true);
    return events.map((event) => event.join_signal);
  };
  return { client, peer, transport, signals };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

describe(symptom, () => {
  it("records the Sync startup deadline, not an SFU failure", async () => {
    const test = scenario({ syncTimeout: true });
    const joined = test.client.join({ microphone: false, camera: false }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(65_000);
    await joined;
    expect(await test.signals()).toEqual(expect.arrayContaining(["started", "sync_started", "sync_timeout"]));
  });

  it.each([
    ["signaling", CONNECTED, "publish_failed"],
    ["failed ICE", { connection: "failed", ice: "failed" }, "startup_ice_failed"],
    ["checking ICE", { connection: "connecting", ice: "checking" }, "transport_timeout"],
  ] satisfies readonly (readonly [string, TransportState, string])[])("records terminal initial publish failure: %s", async (fault, state, signal) => {
    const test = scenario();
    test.peer.answerState = state;
    if (fault === "signaling") test.transport.localPublishFailure = new CloudflareSFUError("injected refusal", "signaling_failed");
    const joined = test.client.join({ microphone: true, camera: false }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await joined;
    expect(await test.signals()).toContain(signal);
  });

  it("requires both RTP directions before declaring a published Join ready", async () => {
    const test = scenario();
    test.peer.sendPackets = 10;
    const joined = test.client.join({ microphone: true, camera: false });
    await joined;
    await vi.advanceTimersByTimeAsync(2_000);
    const before = await test.signals();
    expect(before).toContain("send_rtp");
    expect(before).not.toContain("ready");
    test.peer.receivePackets = 11;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await test.signals()).toEqual(expect.arrayContaining(["sync_entered", "publish_accepted", "subscribe_accepted", "dtls_connected", "receive_rtp", "ready"]));
  });

  it.each([
    ["NotAllowedError", "mic_denied"],
    ["NotFoundError", "mic_absent"],
  ])("receives through TURN with %s and never claims send RTP", async (deviceError, disposition) => {
    const test = scenario({ deviceError });
    const joined = test.client.join({ microphone: true, camera: false });
    await joined;
    await vi.advanceTimersByTimeAsync(2_000);
    test.peer.route = "relay";
    test.peer.receivePackets = 12;
    await vi.advanceTimersByTimeAsync(2_000);
    const evidence = await test.signals();
    expect(evidence).toEqual(expect.arrayContaining([disposition, "publish_skipped", "direct_selected", "relay_selected", "relay_fallback", "receive_rtp", "listen_only"]));
    expect(evidence).not.toContain("send_rtp");
  });

  it("records a subscription timeout only after a real pull attempt", async () => {
    const test = scenario({ pullFails: true });
    const joined = test.client.join({ microphone: false, camera: false });
    await joined;
    await vi.advanceTimersByTimeAsync(33_000);
    expect(await test.signals()).toEqual(expect.arrayContaining(["subscribe_started", "subscribe_failed", "subscribe_timeout"]));
  });

  it("distinguishes zero RTP from an absent counter", async () => {
    const test = scenario();
    const joined = test.client.join({ microphone: false, camera: false });
    await joined;
    await vi.advanceTimersByTimeAsync(33_000);
    expect(await test.signals()).not.toContain("rtp_timeout");
    test.peer.receivePackets = 0;
    await vi.advanceTimersByTimeAsync(32_000);
    expect(await test.signals()).toContain("rtp_timeout");
  });
});
