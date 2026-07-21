import { describe, expect, it, vi } from "vitest";

import { CloudflareSFUClient, CloudflareSFUError, createCloudflareSFUHTTPTransport, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUCloseTrackRequest, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription, CloudflareSFUSignalingTransport, CloudflareSFUTrackRequest, CloudflareSFUTracksResponse } from "./cloudflare-sfu";

describe("Cloudflare SFU HTTP signaling", () => {
  it("reads a fresh media credential before every signaling request", async () => {
    const authoritativePublicationId = versionedPublicationID("connection-1", "0", "camera-track");
    const credentials = ["token-1", "token-2", "token-3", "token-4"];
    const credential = vi.fn(async () => credentials.shift() ?? "unexpected");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/publications")
        ? { incarnation: 1, sequence: 2, publications: [{ participant_session_id: "participant-2", source: "camera", publication_id: "provider-session|camera-track" }] }
        : path.endsWith("/tracks")
          ? { sessionDescription: { type: "answer", sdp: "provider-answer" }, tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera", publication_id: authoritativePublicationId }] }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "http://localhost:8080/",
      credential,
      tenantId: "tenant-1",
      roomId: "room-1",
      sessionId: "session-1",
      participantSessionId: "participant-1",
      fetch,
    });

    const added = await transport.addTracks({
      connectionId: "connection-1",
      sessionDescription: { type: "offer", sdp: "browser-offer" },
      tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera" }],
    });
    expect(added.tracks?.[0]?.publicationId).toBe(authoritativePublicationId);
    await transport.closeTracks({ connectionId: "connection-1", tracks: [{ mid: "0", source: "camera", publicationId: authoritativePublicationId }] });
    await transport.renegotiate({ connectionId: "connection-1", sessionDescription: { type: "answer", sdp: "browser-answer" } });
    await expect(transport.listPublications()).resolves.toEqual({
      incarnation: 1,
      sequence: 2,
      publications: [{ participantSessionId: "participant-2", source: "camera", publicationId: "provider-session|camera-track" }],
    });

    expect(credential).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3", "Bearer token-4"]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/tracks",
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/tracks/close",
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/renegotiate",
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/publications",
    ]);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain(`"publication_id":"${authoritativePublicationId}"`);
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain("app_secret");
  });

  it("keeps the fixed bearer option as a compatibility bridge", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "legacy-token", tenantId: "t", roomId: "r", sessionId: "s", participantSessionId: "p", fetch });
    await transport.listPublications();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer legacy-token");
  });

  it("rejects ambiguous publication references", () => {
    expect(parseCloudflareSFUPublicationID("provider-session|camera-track")).toEqual({ sessionId: "provider-session", trackName: "camera-track" });
    expect(() => parseCloudflareSFUPublicationID("missing-separator")).toThrow(CloudflareSFUError);
    expect(() => parseCloudflareSFUPublicationID("a|b|c")).toThrow(CloudflareSFUError);
  });
});

describe("Cloudflare SFU client", () => {
  it("starts without local tracks so receive-only sessions do not need getUserMedia", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    expect(harness.transport.addInputs).toEqual([]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, localTracks: [] });
    harness.client.stop();
  });

  it("publishes camera and microphone, validates V3 targets, and retains provider identity while disabled", async () => {
    const harness = createHarness();
    const microphone = new FakeTrack("microphone-track", "audio");
    const camera = new FakeTrack("camera-track", "video");
    const initialSnapshot = harness.client.getSnapshot();
    expect(harness.client.getSnapshot()).toBe(initialSnapshot);
    const changes = vi.fn();
    harness.client.subscribe(changes);

    await harness.client.start(fakeStream(microphone, camera));
    expect(harness.transport.addInputs[0]?.tracks.map((track) => track.source)).toEqual(["microphone", "camera"]);
    expect(harness.client.getSnapshot()).not.toBe(initialSnapshot);
    expect(Object.isFrozen(harness.client.getSnapshot())).toBe(true);
    expect(Object.isFrozen(harness.client.getSnapshot().localTracks)).toBe(true);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "wrong", participantSessionId: "participant-2", source: "camera", enabled: false })).resolves.toEqual({ outcome: "terminal_failure", errorCode: "invalid_participant" });
    await expect(harness.client.setLocalPublicationTarget({ operationId: "disable", participantSessionId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.closeInputs).toHaveLength(1);
    expect(harness.transport.closeInputs[0]?.tracks).toEqual([{ mid: "1", source: "camera", publicationId: versionedPublicationID("connection-1", "1", "camera-track") }]);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({ enabled: false, publicationId: null });

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantSessionId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({
      enabled: true,
      publicationId: versionedPublicationID("connection-1", "2", "camera-track"),
    });
    expect(changes).toHaveBeenCalled();
    harness.client.stop();
  });

  it("serializes concurrent SDP close operations", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));
    harness.transport.blockClose = true;

    const microphone = harness.client.setLocalPublicationTarget({ operationId: "mic-off", participantSessionId: "participant-1", source: "microphone", enabled: false });
    const camera = harness.client.setLocalPublicationTarget({ operationId: "cam-off", participantSessionId: "participant-1", source: "camera", enabled: false });
    await vi.waitFor(() => expect(harness.transport.closeInputs).toHaveLength(1));
    harness.transport.releaseClose();
    await vi.waitFor(() => expect(harness.transport.closeInputs).toHaveLength(2));
    harness.transport.releaseClose();
    await expect(Promise.all([microphone, camera])).resolves.toEqual([
      { outcome: "confirmed", errorCode: null },
      { outcome: "confirmed", errorCode: null },
    ]);
    expect(harness.transport.maximumConcurrentClose).toBe(1);
    harness.client.stop();
  });

  it("retires every closed sender across repeated disable and enable cycles", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;

    for (let cycle = 0; cycle < 3; cycle++) {
      const closingSender = peer.getSenders().at(-1);
      await expect(harness.client.setLocalPublicationTarget({ operationId: `disable-${cycle}`, participantSessionId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(closingSender?.track).toBeNull();
      expect(peer.activeTransceiverCount()).toBe(0);

      await expect(harness.client.setLocalPublicationTarget({ operationId: `enable-${cycle}`, participantSessionId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(peer.activeTransceiverCount()).toBe(1);
      expect(
        peer
          .getSenders()
          .slice(0, -1)
          .every((sender) => sender.track === null),
      ).toBe(true);
    }

    harness.client.stop();
  });

  it("reconciles authoritative remote removal, re-addition, replacement, and monotonic cursors", async () => {
    const harness = await startedRemoteHarness("remote-session|camera-a");
    await harness.client.refreshRemotePublications();
    const first = harness.client.getSnapshot().remoteTracks[0];
    expect(first?.publicationId).toBe("remote-session|camera-a");
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });

    harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
    await harness.client.refreshRemotePublications();
    expect(first?.track.readyState).toBe("ended");
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);

    harness.transport.snapshot = publicationSnapshot(1, 3, "remote-session|camera-a");
    await harness.client.refreshRemotePublications();
    const second = harness.client.getSnapshot().remoteTracks[0];
    expect(second?.track).not.toBe(first?.track);

    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-session|stale-camera");
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]).toBe(second);

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-session|camera-b");
    await harness.client.refreshRemotePublications();
    expect(second?.track.readyState).toBe("ended");
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-session|camera-b");

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-session|conflict");
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "invalid_publication" });
    harness.client.stop();
  });

  it("pulls a real versioned Chalk publication through its embedded provider reference", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    const publicationId = versionedPublicationID("remote-connection", "remote-mid", "remote-camera-track");
    harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);

    await harness.client.refreshRemotePublications();

    expect(harness.transport.addInputs.at(-1)?.tracks).toEqual([{ location: "remote", sessionId: "remote-connection", trackName: "remote-camera-track" }]);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId);
    harness.client.stop();
  });

  it("does not advance the authoritative cursor when a remote pull fails", async () => {
    const harness = await startedRemoteHarness("remote-session|camera-a");
    harness.transport.failNextRemotePull = true;
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);

    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-session|camera-a");
    harness.client.stop();
  });

  it("reports a failed immediate renegotiation without advancing remote state", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-session|camera-a");
    harness.transport.immediateRenegotiation = true;
    harness.transport.failRenegotiation = true;

    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "failed" }, failure: { code: "signaling_failed", recoverable: true }, remoteTracks: [] });
    harness.client.stop();
  });

  it("notifies browser-ended screen capture and preserves the source for the subsequent V3 disable target", async () => {
    const onScreenEnded = vi.fn();
    const harness = createHarness({ onScreenEnded });
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const screen = new FakeTrack("screen-track", "video");
    harness.client.prepareLocalTrack("screen", screen as unknown as MediaStreamTrack);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "screen-start", participantSessionId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });

    screen.endFromBrowser();
    expect(onScreenEnded).toHaveBeenCalledOnce();
    await expect(harness.client.setLocalPublicationTarget({ operationId: "screen-ended", participantSessionId: "participant-1", source: "screen", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.closeInputs.at(-1)?.tracks).toHaveLength(1);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: false, publicationId: null });
    await harness.client.clearPreparedLocalTrack("screen");
    expect(harness.client.getSnapshot().localTracks.some((publication) => publication.source === "screen")).toBe(false);
    expect(screen.readyState).toBe("ended");
    harness.client.stop();
  });

  it("publishes recoverable peer and ICE failures", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    peer.setStates("disconnected", "connected");
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "recovering" }, failure: null });
    peer.setStates("disconnected", "failed");
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "failed" }, failure: { code: "ice_connection_failed", recoverable: true } });
    harness.client.stop();
  });

  it("uses fresh bootstrap during a generation-safe restart", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    harness.transport.blockConnection("connection-2");
    const firstRestart = harness.client.restart({ bootstrap: bootstrap("connection-2") });
    await vi.waitFor(() => expect(harness.transport.addInputs.some((input) => input.connectionId === "connection-2")).toBe(true));

    const secondRestart = harness.client.restart({ bootstrap: bootstrap("connection-3") });
    harness.transport.releaseConnection("connection-2");
    await expect(firstRestart).rejects.toMatchObject({ code: "stale_generation" });
    await secondRestart;
    expect(harness.transport.addInputs.at(-1)?.connectionId).toBe("connection-3");
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });
    expect(harness.client.getSnapshot().localTracks[0]?.publicationId).toBe(versionedPublicationID("connection-3", "0", "camera-track"));
    harness.client.stop();
  });

  it("idempotently stops every owned track even when tracks and consumer callbacks throw", async () => {
    const reported = vi.fn(() => {
      throw new Error("consumer onError failed");
    });
    const harness = createHarness({ onError: reported });
    const camera = new FakeTrack("camera-track", "video", true);
    await harness.client.start(fakeStream(camera));
    harness.client.subscribe(() => {
      throw new Error("consumer snapshot failed");
    });
    const peer = harness.peers[0] as FakePeerConnection;
    peer.throwOnCleanup = true;

    expect(() => harness.client.stop()).not.toThrow();
    expect(() => harness.client.stop()).not.toThrow();
    expect(camera.stopCalls).toBeGreaterThan(0);
    expect(peer.closed).toBe(true);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "stopped" }, localTracks: [], remoteTracks: [] });
    expect(reported).toHaveBeenCalled();
  });
});

async function startedRemoteHarness(publicationId: string): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness();
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);
  return harness;
}

function bootstrap(connectionId: string): CloudflareSFUBootstrap {
  return { connectionId, stunServer: "stun:example.test" };
}

function publicationSnapshot(incarnation: number, sequence: number, publicationId: string): CloudflareSFUPublicationSnapshot {
  return { incarnation, sequence, publications: [{ participantSessionId: "participant-2", source: "camera", publicationId }] };
}

function versionedPublicationID(connectionId: string, mid: string, trackName: string): string {
  const payload = JSON.stringify({ c: connectionId, m: mid, t: trackName, g: 1 });
  return `chalk_pub_v1.${globalThis.btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function fakeStream(...tracks: readonly FakeTrack[]): MediaStream {
  return { getTracks: () => tracks as unknown as MediaStreamTrack[] } as MediaStream;
}

function createHarness(options: { readonly onError?: (error: unknown) => void; readonly onScreenEnded?: () => void } = {}) {
  const peers: FakePeerConnection[] = [];
  const transport = new FakeTransport(() => peers.at(-1));
  const client = new CloudflareSFUClient({
    bootstrap: bootstrap("connection-1"),
    participantSessionId: "participant-1",
    transport,
    pollIntervalMs: 60_000,
    onError: options.onError,
    onScreenEnded: options.onScreenEnded,
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
  });
  return { client, peers, transport };
}

class FakeTransport implements CloudflareSFUSignalingTransport {
  readonly addInputs: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }[] = [];
  readonly closeInputs: { readonly connectionId: string; readonly tracks: readonly CloudflareSFUCloseTrackRequest[] }[] = [];
  blockClose = false;
  failNextRemotePull = false;
  failRenegotiation = false;
  immediateRenegotiation = false;
  maximumConcurrentClose = 0;
  snapshot: CloudflareSFUPublicationSnapshot = { incarnation: 1, sequence: 0, publications: [] };
  #activeClose = 0;
  readonly #blockedConnections = new Map<string, () => void>();
  readonly #closeResolvers: (() => void)[] = [];
  readonly #peer: () => FakePeerConnection | undefined;

  constructor(peer: () => FakePeerConnection | undefined) {
    this.#peer = peer;
  }

  async addTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }): Promise<CloudflareSFUTracksResponse> {
    this.addInputs.push(input);
    const unblock = this.#blockedConnections.get(input.connectionId);
    if (unblock) await new Promise<void>((resolve) => this.#blockedConnections.set(input.connectionId, resolve));
    if (input.tracks.some((track) => track.location === "remote")) {
      if (this.failNextRemotePull) {
        this.failNextRemotePull = false;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      const tracks = input.tracks.map((track, index) => ({ ...track, mid: `remote-${index}` }));
      tracks.forEach((track, index) => this.#peer()?.emitTrack(track.mid, new FakeTrack(`pulled-${track.trackName}-${index}`, track.trackName.includes("microphone") ? "audio" : "video")));
      return {
        tracks,
        requiresImmediateRenegotiation: this.immediateRenegotiation,
        sessionDescription: this.immediateRenegotiation ? { type: "offer", sdp: "remote-offer" } : undefined,
      };
    }
    return {
      sessionDescription: { type: "answer", sdp: `answer:${input.connectionId}` },
      tracks: input.tracks.map((track) => ({ ...track, publicationId: versionedPublicationID(input.connectionId, track.mid ?? "", track.trackName) })),
    };
  }

  async closeTracks(input: { readonly connectionId: string; readonly tracks: readonly CloudflareSFUCloseTrackRequest[] }): Promise<CloudflareSFUTracksResponse> {
    this.closeInputs.push(input);
    this.#activeClose++;
    this.maximumConcurrentClose = Math.max(this.maximumConcurrentClose, this.#activeClose);
    if (this.blockClose) await new Promise<void>((resolve) => this.#closeResolvers.push(resolve));
    this.#activeClose--;
    return {};
  }

  async renegotiate(): Promise<void> {
    if (this.failRenegotiation) throw new CloudflareSFUError("renegotiation failed", "signaling_failed");
  }

  async listPublications(): Promise<CloudflareSFUPublicationSnapshot> {
    return this.snapshot;
  }

  blockConnection(connectionId: string): void {
    this.#blockedConnections.set(connectionId, () => undefined);
  }

  releaseConnection(connectionId: string): void {
    this.#blockedConnections.get(connectionId)?.();
    this.#blockedConnections.delete(connectionId);
  }

  releaseClose(): void {
    this.#closeResolvers.shift()?.();
  }
}

class FakeTrack extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  stopCalls = 0;
  readonly id: string;
  readonly kind: "audio" | "video";
  readonly #throwOnStop: boolean;

  constructor(id: string, kind: "audio" | "video", throwOnStop = false) {
    super();
    this.id = id;
    this.kind = kind;
    this.#throwOnStop = throwOnStop;
  }

  stop(): void {
    this.stopCalls++;
    this.readyState = "ended";
    if (this.#throwOnStop) throw new Error("track stop failed");
  }

  endFromBrowser(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  closed = false;
  throwOnCleanup = false;
  readonly #activeTransceivers = new Set<RTCRtpTransceiver>();
  readonly #transceivers: RTCRtpTransceiver[] = [];

  addTransceiver(track: MediaStreamTrack): RTCRtpTransceiver {
    let senderTrack: MediaStreamTrack | null = track;
    const sender = {
      get track() {
        return senderTrack;
      },
      replaceTrack: async (replacement: MediaStreamTrack | null) => {
        senderTrack = replacement;
      },
    } as RTCRtpSender;
    let transceiver: RTCRtpTransceiver;
    transceiver = {
      mid: String(this.#transceivers.length),
      sender,
      stop: () => {
        if (this.throwOnCleanup) throw new Error("transceiver stop failed");
        this.#activeTransceivers.delete(transceiver);
      },
    } as unknown as RTCRtpTransceiver;
    this.#transceivers.push(transceiver);
    this.#activeTransceivers.add(transceiver);
    return transceiver;
  }

  activeTransceiverCount(): number {
    return this.#activeTransceivers.size;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "browser-offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "browser-answer" };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {}

  getSenders(): RTCRtpSender[] {
    return this.#transceivers.map((transceiver) => transceiver.sender);
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.#transceivers;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    if (this.throwOnCleanup) throw new Error("peer close failed");
  }

  setStates(connectionState: RTCPeerConnectionState, iceConnectionState: RTCIceConnectionState): void {
    this.connectionState = connectionState;
    this.iceConnectionState = iceConnectionState;
    this.dispatchEvent(new Event("connectionstatechange"));
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }

  emitTrack(mid: string, track: FakeTrack): void {
    const event = new Event("track");
    Object.defineProperties(event, {
      track: { value: track as unknown as MediaStreamTrack },
      transceiver: { value: { mid } },
    });
    this.dispatchEvent(event);
  }
}
