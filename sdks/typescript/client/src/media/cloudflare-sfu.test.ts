import { describe, expect, it, vi } from "vitest";
import { CloudflareSFUClient, CloudflareSFUError, createCloudflareSFUHTTPTransport, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUClientOptions, CloudflareSFUCloseTrackRequest, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription, CloudflareSFUSignalingTransport, CloudflareSFUTrackRequest, CloudflareSFUTracksResponse } from "./cloudflare-sfu";
async function expectStalledRequestRecovers(transport: CloudflareSFUSignalingTransport, timeoutMs: number, wasAborted: () => boolean): Promise<void> {
  const stalled = transport.listPublications();
  const rejected = expect(stalled).rejects.toMatchObject({ code: "signaling_timeout" });
  await vi.advanceTimersByTimeAsync(timeoutMs);
  await rejected;
  expect(wasAborted()).toBe(true);
  await expect(transport.listPublications()).resolves.toMatchObject({ publications: [] });
}
describe("Cloudflare SFU HTTP signaling", () => {
  it("reads a fresh media credential before every signaling request", async () => {
    const authoritativePublicationId = versionedPublicationID("connection-1", "0", "camera-track");
    const credentials = ["token-1", "token-2", "token-3", "token-4"];
    const credential = vi.fn(async () => credentials.shift() ?? "unexpected");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/publications")
        ? { incarnation: 1, sequence: 2, publications: [{ participant_session_id: "participant-2", source: "camera", publication_id: "provider-connection|camera-track" }] }
        : path.endsWith("/tracks")
          ? { sessionDescription: { type: "answer", sdp: "provider-answer" }, tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera", publication_id: authoritativePublicationId }] }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "http://localhost:8080/",
      credential,
      tenantId: "tenant-1",
      spaceId: "space-1",
      episodeId: "episode-1",
      participantId: "participant-1",
      fetch,
    });
    const added = await transport.addTracks({
      connectionId: "connection-1",
      sessionDescription: { type: "offer", sdp: "browser-offer" },
      tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera" }],
    });
    expect(added.tracks?.[0]?.publicationId).toBe(authoritativePublicationId);
    await transport.closeTracks({ connectionId: "connection-1", tracks: [{ mid: "0", source: "camera", publicationId: authoritativePublicationId }], force: true });
    await transport.renegotiate({ connectionId: "connection-1", sessionDescription: { type: "answer", sdp: "browser-answer" } });
    await expect(transport.listPublications()).resolves.toEqual({
      incarnation: 1,
      sequence: 2,
      publications: [{ participantId: "participant-2", source: "camera", publicationId: "provider-connection|camera-track" }],
    });
    expect(credential).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3", "Bearer token-4"]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/tracks",
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/tracks/close",
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/renegotiate",
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/publications",
    ]);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain(`"publication_id":"${authoritativePublicationId}"`);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain(`"force":true`);
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain("app_secret");
    expect(parseCloudflareSFUPublicationID("provider-connection|camera-track")).toEqual({ connectionId: "provider-connection", trackName: "camera-track" });
    expect(() => parseCloudflareSFUPublicationID("missing-separator")).toThrow(CloudflareSFUError);
    expect(() => parseCloudflareSFUPublicationID("a|b|c")).toThrow(CloudflareSFUError);
  });
  it("keeps the fixed bearer option as a compatibility bridge", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "legacy-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    await transport.listPublications();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer legacy-token");
  });
  it("opts into partial replies without changing the strict legacy request body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({ tracks: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "media-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    const input = { connectionId: "connection-1", tracks: [] };
    await transport.addTracks(input);
    await transport.addTracks({ ...input, allowPartialRemoteTracks: true });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/tracks$/);
    expect(String(fetch.mock.calls[1]?.[0])).toMatch(/\/tracks\?allow_partial_remote_tracks=true$/);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
  });
  it("marks expired provider connections as retryable connection failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("connection expired", { status: 410 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "media-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    await expect(transport.addTracks({ connectionId: "stale-connection", tracks: [] })).rejects.toMatchObject({
      code: "signaling_failed",
      options: { status: 410, retryableConnection: true },
    });
  });
  it("aborts stalled signaling and permits the next request", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      let requests = 0;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
        requests += 1;
        if (requests === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 });
      });
      const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "media-token", tenantId: "t", spaceId: "s", episodeId: "e", participantId: "p", fetch, requestTimeoutMs: 10 });
      await expectStalledRequestRecovers(transport, 10, () => aborted);
    } finally {
      vi.useRealTimers();
    }
  });
  it("gives signaling its full deadline after a slow credential refresh", async () => {
    vi.useFakeTimers();
    try {
      let resolveCredential: (token: string) => void = () => {};
      const credential = () =>
        new Promise<string>((resolve) => {
          resolveCredential = resolve;
        });
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
        return new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 });
      });
      const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", credential, tenantId: "t", spaceId: "s", episodeId: "e", participantId: "p", fetch, requestTimeoutMs: 10 });
      const result = transport.listPublications();
      await vi.advanceTimersByTimeAsync(9);
      resolveCredential("media-token");
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toMatchObject({ publications: [] });
    } finally {
      vi.useRealTimers();
    }
  });
  it("aborts a stalled credential refresh and permits the next request", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let aborted = false;
      const credential = (signal?: AbortSignal) => {
        attempts += 1;
        if (attempts > 1) return Promise.resolve("media-token");
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
      const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", credential, tenantId: "t", spaceId: "s", episodeId: "e", participantId: "p", fetch });
      await expectStalledRequestRecovers(transport, 7000, () => aborted);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["incomplete", "discovery"] as const)("backs off %s polling and resets after success", async (mode) => {
    await withTimedHarness(
      async (harness) => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const list = vi.spyOn(harness.transport, "listPublications");
        if (mode === "discovery") list.mockRejectedValue(new CloudflareSFUError("discovery unavailable", "signaling_failed"));
        await harness.client.start(fakeStream());
        const snapshot = publicationSnapshot(1, 1, "remote-connection|screen-a");
        harness.transport.snapshot = { ...snapshot, publications: snapshot.publications.map((publication) => ({ ...publication, source: "screen" })) };
        harness.transport.omittedRemoteTrackNames.add("screen-a");
        const attempts = mode === "discovery" ? list : vi.spyOn(harness.transport, "addTracks");
        await vi.advanceTimersByTimeAsync(0);
        for (const delay of mode === "discovery" ? [500, 1000, 2000, 4000, 8000, 15000, 15000] : [750, 1500, 3000, 6000, 12000, 15000, 15000]) {
          const before = attempts.mock.calls.length;
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(attempts).toHaveBeenCalledTimes(before);
          await vi.advanceTimersByTimeAsync(1);
          expect(attempts).toHaveBeenCalledTimes(before + 1);
        }
        list.mockRestore();
        harness.transport.omittedRemoteTrackNames.clear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
        if (mode === "discovery") {
          const failingAgain = vi.spyOn(harness.transport, "listPublications").mockRejectedValue(new CloudflareSFUError("discovery unavailable", "signaling_failed"));
          await vi.advanceTimersByTimeAsync(15000);
          await vi.advanceTimersByTimeAsync(500);
          expect(failingAgain).toHaveBeenCalledTimes(2);
          harness.peerConnectionFactory.mockImplementationOnce(() => {
            expect(harness.client.getSnapshot().connection.phase).toBe("recovering");
            throw new Error("peer creation failed after disposal");
          });
          await expect(harness.client.restart(bootstrap("connection-2"))).rejects.toThrow("peer creation failed");
          expect(harness.client.getSnapshot().connection.phase).toBe("failed");
          await harness.client.restart(bootstrap("connection-3"));
          expect(harness.client.getSnapshot().connection.phase).toBe("live");
        }
      },
      { pollIntervalMs: 15000 },
    );
  });
});
async function startedCameraHarness() {
  const harness = createHarness();
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  const peer = harness.peers[0] as FakePeerConnection;
  const transceiver = peer.getTransceivers()[0];
  return { harness, peer, transceiver };
}
async function startedRemoteHarness(publicationId: string): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness();
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);
  return harness;
}
function expectCameraEncodings(peer: FakePeerConnection | undefined): void {
  expect(
    peer
      ?.getSenders()
      .find((sender) => sender.track?.kind === "video")
      ?.getParameters().encodings,
  ).toEqual([
    { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2500000, scalabilityMode: "L1T1" },
    { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650000, scalabilityMode: "L1T1" },
  ]);
}
async function startedReplaceableHarness() {
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const onError = vi.fn();
  const harness = createHarness({ onError, replaceMediaConnection });
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  return { harness, onError, replaceMediaConnection };
}
async function startedCameraAndScreenRemoteHarness() {
  const harness = await startedRemoteHarness("remote-connection|camera-a");
  harness.transport.snapshot = {
    ...harness.transport.snapshot,
    publications: [...harness.transport.snapshot.publications, { participantId: "participant-3", source: "screen", publicationId: "presenter-connection|screen-b" }],
  };
  return harness;
}
async function expectNoAdditionalRemotePull(harness: ReturnType<typeof createHarness>): Promise<void> {
  const count = remotePullCount(harness);
  await harness.client.refreshRemotePublications();
  expect(remotePullCount(harness)).toBe(count);
}
function remotePullCount(harness: ReturnType<typeof createHarness>): number {
  return harness.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "remote")).length;
}
function bootstrap(connectionId: string): CloudflareSFUBootstrap {
  return { connectionId, stunServer: "stun:example.test" };
}
function publicationSnapshot(incarnation: number, sequence: number, publicationId: string): CloudflareSFUPublicationSnapshot {
  return { incarnation, sequence, publications: [{ participantId: "participant-2", source: "camera", publicationId }] };
}
function versionedPublicationID(connectionId: string, mid: string, trackName: string): string {
  const payload = JSON.stringify({ c: connectionId, m: mid, t: trackName, g: 1 });
  return `chalk_pub_v1.${globalThis.btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
function fakeStream(...tracks: readonly FakeTrack[]): MediaStream {
  return { getTracks: () => tracks as unknown as MediaStreamTrack[] } as MediaStream;
}
function setScreenTarget(client: CloudflareSFUClient, operationId: string, enabled: boolean) {
  return client.setLocalPublicationTarget({ operationId, participantId: "participant-1", source: "screen", enabled });
}
async function startScreenPublication(harness: ReturnType<typeof createHarness>, track: FakeTrack, operationId = "screen-start"): Promise<void> {
  harness.client.prepareLocalTrack("screen", track as unknown as MediaStreamTrack);
  await expect(setScreenTarget(harness.client, operationId, true)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
  expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });
}
function createHarness(
  options: {
    readonly autoConnect?: boolean;
    readonly onError?: (error: unknown) => void;
    readonly onScreenEnded?: () => void;
    readonly replaceMediaConnection?: () => Promise<CloudflareSFUBootstrap>;
    readonly pollIntervalMs?: number;
  } = {},
) {
  const peers: FakePeerConnection[] = [];
  const transport = new FakeTransport(() => peers.at(-1));
  const peerConnectionFactory = vi.fn(() => {
    const peer = new FakePeerConnection(options.autoConnect ?? true);
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  });
  const client = new CloudflareSFUClient({
    bootstrap: bootstrap("connection-1"),
    participantId: "participant-1",
    transport,
    replaceMediaConnection: options.replaceMediaConnection,
    pollIntervalMs: options.pollIntervalMs ?? 60000,
    onError: options.onError,
    onScreenEnded: options.onScreenEnded,
    peerConnectionFactory,
  });
  return { client, peers, transport, peerConnectionFactory };
}
class FakeTransport implements CloudflareSFUSignalingTransport {
  readonly addInputs: {
    readonly connectionId: string;
    readonly sessionDescription?: CloudflareSFUSessionDescription;
    readonly tracks: readonly CloudflareSFUTrackRequest[];
  }[] = [];
  readonly closeInputs: {
    readonly connectionId: string;
    readonly sessionDescription?: CloudflareSFUSessionDescription;
    readonly tracks: readonly CloudflareSFUCloseTrackRequest[];
    readonly force: boolean;
  }[] = [];
  blockPublicationList = false;
  readonly localPublications = new Map<string, CloudflareSFUPublicationSnapshot["publications"][number]>();
  failNextLocalPublish = false;
  failNextStaleLocalPublish = false;
  failNextRemotePull = false;
  readonly omittedRemoteTrackNames = new Set<string>();
  readonly failedRemoteTrackNames = new Map<string, string>();
  reverseRemoteTracks = false;
  failRemotePullCount = 0;
  failRenegotiation = false;
  immediateRenegotiation = false;
  listPublicationCalls = 0;
  maxLocalMids: number | null = null;
  snapshot: CloudflareSFUPublicationSnapshot = { incarnation: 1, sequence: 0, publications: [] };
  readonly #blockedConnections = new Map<string, () => void>();
  readonly #localMids = new Set<string>();
  readonly #publicationListResolvers: (() => void)[] = [];
  readonly #peer: () => FakePeerConnection | undefined;
  constructor(peer: () => FakePeerConnection | undefined) {
    this.#peer = peer;
  }
  async addTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }): Promise<CloudflareSFUTracksResponse> {
    this.addInputs.push(input);
    const unblock = this.#blockedConnections.get(input.connectionId);
    if (unblock) await new Promise<void>((resolve) => this.#blockedConnections.set(input.connectionId, resolve));
    if (input.tracks.some((track) => track.location === "remote")) {
      if (this.failRemotePullCount > 0) {
        this.failRemotePullCount--;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      if (this.failNextRemotePull) {
        this.failNextRemotePull = false;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      const tracks = input.tracks.filter((track) => !this.omittedRemoteTrackNames.has(track.trackName) && !this.failedRemoteTrackNames.has(track.trackName)).map((track, index) => ({ ...track, mid: `remote-${index}` }));
      const trackErrors = input.tracks.flatMap((track) => {
        const code = this.failedRemoteTrackNames.get(track.trackName);
        return code ? [{ connectionId: "remote-connection", trackName: track.trackName, code }] : [];
      });
      if (this.reverseRemoteTracks) tracks.reverse();
      tracks.forEach((track, index) => this.#peer()?.emitTrack(track.mid, new FakeTrack(`pulled-${track.trackName}-${index}`, track.trackName.includes("microphone") ? "audio" : "video")));
      const requiresImmediateRenegotiation = this.immediateRenegotiation || this.#peer()?.connectionState !== "connected";
      return {
        tracks,
        trackErrors,
        requiresImmediateRenegotiation,
        sessionDescription: requiresImmediateRenegotiation ? { type: "offer", sdp: "remote-offer" } : undefined,
      };
    }
    if (this.failNextLocalPublish) {
      this.failNextLocalPublish = false;
      throw new CloudflareSFUError("local publish failed", "signaling_failed");
    }
    if (this.failNextStaleLocalPublish) {
      this.failNextStaleLocalPublish = false;
      throw new CloudflareSFUError("stale local publish failed", "signaling_failed", { status: 410, retryableConnection: true });
    }
    const localMids = input.tracks.flatMap((track) => (track.location === "local" && track.mid !== undefined ? [track.mid] : []));
    const nextLocalMids = new Set([...this.#localMids, ...localMids]);
    if (this.maxLocalMids !== null && nextLocalMids.size > this.maxLocalMids) throw new CloudflareSFUError("local media-section budget exceeded", "signaling_failed");
    for (const mid of localMids) this.#localMids.add(mid);
    const tracks = input.tracks.map((track) => ({ ...track, publicationId: versionedPublicationID(input.connectionId, track.mid ?? "", track.trackName) }));
    for (const track of tracks) {
      if (track.source) this.localPublications.set(track.publicationId, { participantId: "participant-1", source: track.source, publicationId: track.publicationId });
    }
    return {
      sessionDescription: { type: "answer", sdp: `answer:${input.connectionId}` },
      tracks,
    };
  }
  async closeTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUCloseTrackRequest[]; readonly force: boolean }): Promise<CloudflareSFUTracksResponse> {
    this.closeInputs.push(input);
    for (const track of input.tracks) this.localPublications.delete(track.publicationId);
    return input.sessionDescription ? { sessionDescription: { type: "answer", sdp: "close-answer" } } : {};
  }
  async renegotiate(): Promise<void> {
    if (this.failRenegotiation) throw new CloudflareSFUError("renegotiation failed", "signaling_failed");
  }
  async listPublications(): Promise<CloudflareSFUPublicationSnapshot> {
    this.listPublicationCalls++;
    if (this.blockPublicationList) await new Promise<void>((resolve) => this.#publicationListResolvers.push(resolve));
    return { ...this.snapshot, publications: [...this.snapshot.publications, ...this.localPublications.values()] };
  }
  blockConnection(connectionId: string): void {
    this.#blockedConnections.set(connectionId, () => undefined);
  }
  releaseConnection(connectionId: string): void {
    this.#blockedConnections.get(connectionId)?.();
    this.#blockedConnections.delete(connectionId);
  }
  releasePublicationList(): void {
    this.#publicationListResolvers.shift()?.();
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
  signalingState: RTCSignalingState = "stable";
  closed = false;
  rollbackCalls = 0;
  throwOnCleanup = false;
  readonly transceiverInits: RTCRtpTransceiverInit[] = [];
  refuseSimulcast = false;
  refuseSimulcastOffer = false;
  readonly #activeTransceivers = new Set<RTCRtpTransceiver>();
  readonly #autoConnect: boolean;
  readonly #transceivers: RTCRtpTransceiver[] = [];
  #nextRemoteDescriptionStates: {
    readonly connection: RTCPeerConnectionState;
    readonly ice: RTCIceConnectionState;
  } | null = null;
  constructor(autoConnect: boolean) {
    super();
    this.#autoConnect = autoConnect;
  }
  addTransceiver(track: MediaStreamTrack, init: RTCRtpTransceiverInit = {}): RTCRtpTransceiver {
    this.transceiverInits.push(init);
    if (this.refuseSimulcast && init.sendEncodings) throw new DOMException("Simulcast unsupported", "NotSupportedError");
    let senderTrack: MediaStreamTrack | null = track;
    let parameters: Pick<RTCRtpSendParameters, "encodings" | "degradationPreference"> = { encodings: init.sendEncodings ?? [{}] };
    const sender = {
      getParameters: () => ({ ...parameters, encodings: parameters.encodings.map((encoding) => ({ ...encoding })) }),
      setParameters: async (next: RTCRtpSendParameters) => {
        if (this.refuseSenderParameters) throw new DOMException("Sender controls unsupported", "NotSupportedError");
        parameters = { ...next, encodings: next.encodings.map((encoding) => ({ ...encoding })) };
      },
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
    if (this.refuseSimulcastOffer && this.getSenders().some((sender) => sender.track && sender.getParameters().encodings.length > 1)) throw new DOMException("Simulcast unsupported", "NotSupportedError");
    return { type: "offer", sdp: "browser-offer" };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "browser-answer" };
  }
  availableOutgoingBitrate: number | undefined;
  refuseSenderParameters = false;
  getStats(): Promise<RTCStatsReport> {
    const stat: RTCStats = { id: "candidate-pair", timestamp: 0, type: "candidate-pair" };
    Object.assign(stat, { selected: true, state: "succeeded", availableOutgoingBitrate: this.availableOutgoingBitrate });
    const stats = new Map<string, RTCStats>([["candidate-pair", stat]]);
    return Promise.resolve(stats);
  }
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (description?.type === "rollback") {
      this.rollbackCalls++;
      this.signalingState = "stable";
    } else if (description?.type === "offer") {
      this.signalingState = "have-local-offer";
    } else if (description?.type === "answer") {
      this.signalingState = "stable";
    }
  }
  async setRemoteDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.signalingState = description?.type === "offer" ? "have-remote-offer" : "stable";
    if (this.#nextRemoteDescriptionStates) {
      const next = this.#nextRemoteDescriptionStates;
      this.#nextRemoteDescriptionStates = null;
      this.setStates(next.connection, next.ice);
    } else if (this.#autoConnect && this.connectionState === "new") {
      this.setStates("connected", "connected");
    }
  }
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
  setNextRemoteDescriptionStates(connection: RTCPeerConnectionState, ice: RTCIceConnectionState): void {
    this.#nextRemoteDescriptionStates = { connection, ice };
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
async function withTimedHarness(exercise: (harness: ReturnType<typeof createHarness>) => Promise<void>, options: Parameters<typeof createHarness>[0] = {}): Promise<void> {
  vi.useFakeTimers();
  const harness = createHarness(options);
  try {
    await exercise(harness);
  } finally {
    harness.client.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
}
