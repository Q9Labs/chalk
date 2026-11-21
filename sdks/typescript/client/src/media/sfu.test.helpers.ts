import { afterEach, vi } from "vitest";
import type { TransportDiagnostic } from "../transport-diagnostics";
import { SFUClient, SFUError } from "./sfu";
import type { SFUBootstrap, SFUCloseTrackRequest, SFULocalOfferDiagnostic, SFUPublicationSnapshot, SFUSessionDescription, SFUSignalingTransport, SFUTrackRequest, SFUTracksResponse } from "./sfu";

/** The part of a fake peer connection that the fake transport drives when the SFU hands out a remote track. */
export interface TransportPeer {
  readonly connectionState: RTCPeerConnectionState;
  emitTrack(mid: string, track: FakeTrack): void;
}

export function bootstrap(connectionId: string): SFUBootstrap {
  return { connectionId, iceServers: [] };
}
export function publicationSnapshot(incarnation: number, sequence: number, publicationId: string): SFUPublicationSnapshot {
  return { incarnation, sequence, publications: [{ participantId: "participant-2", source: "camera", publicationId }] };
}
export function versionedPublicationID(connectionId: string, mid: string, trackName: string): string {
  const payload = JSON.stringify({ c: connectionId, m: mid, t: trackName, g: 1 });
  return `chalk_pub_v1.${globalThis.btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
export function fakeStream(...tracks: readonly FakeTrack[]): MediaStream {
  return { getTracks: () => tracks as unknown as MediaStreamTrack[] } as MediaStream;
}

export class FakeTransport implements SFUSignalingTransport {
  uniqueRemoteMids = false;
  /** MIDs the SFU hands out again for the next pulls, as it does for a mid whose track was closed. */
  readonly reuseRemoteMids: string[] = [];
  /** The SDP of the SFU's offer after a pull. */
  remoteOfferSDP: string | undefined;
  #nextRemoteMid = 0;
  #localPublicationRevision = 0;
  readonly addInputs: {
    readonly connectionId: string;
    readonly sessionDescription?: SFUSessionDescription;
    readonly tracks: readonly SFUTrackRequest[];
  }[] = [];
  readonly closeInputs: {
    readonly connectionId: string;
    readonly sessionDescription?: SFUSessionDescription;
    readonly tracks: readonly SFUCloseTrackRequest[];
    readonly force: boolean;
  }[] = [];
  listSubscriptions: SFUSignalingTransport["listSubscriptions"];
  readonly localPublications = new Map<string, SFUPublicationSnapshot["publications"][number]>();
  failNextLocalPublish = false;
  nextLocalPublishFailure: Error | null = null;
  localPublishFailure: Error | null = null;
  failNextStaleLocalPublish = false;
  failNextRemotePull = false;
  failCloseCount = 0;
  readonly omittedRemoteTrackNames = new Set<string>();
  readonly failedRemoteTrackNames = new Map<string, string>();
  reverseRemoteTracks = false;
  failRemotePullCount = 0;
  readonly remotePullFailures: unknown[] = [];
  readonly renegotiateInputs: { readonly connectionId: string; readonly sessionDescription: SFUSessionDescription }[] = [];
  failRenegotiation = false;
  immediateRenegotiation = false;
  listPublicationCalls = 0;
  readonly publicationListSnapshots: SFUPublicationSnapshot[] = [];
  maxLocalMids: number | null = null;
  snapshot: SFUPublicationSnapshot = { incarnation: 1, sequence: 0, publications: [] };
  readonly #localMids = new Set<string>();
  readonly #peer: () => TransportPeer | undefined;
  constructor(peer: () => TransportPeer | undefined) {
    this.#peer = peer;
  }
  async addTracks(input: Parameters<SFUSignalingTransport["addTracks"]>[0]): Promise<SFUTracksResponse> {
    this.addInputs.push(input);
    return input.tracks.some((track) => track.location === "remote") ? this.#pullRemote(input) : this.#publishLocal(input);
  }
  #throwQueuedRemotePullFailure(): void {
    if (this.remotePullFailures.length > 0) throw this.remotePullFailures.shift();
    if (this.failRemotePullCount > 0) {
      this.failRemotePullCount--;
      throw new SFUError("remote pull failed", "signaling_failed");
    }
    if (this.failNextRemotePull) {
      this.failNextRemotePull = false;
      throw new SFUError("remote pull failed", "signaling_failed");
    }
  }
  #throwQueuedLocalPublishFailure(): void {
    if (this.failNextLocalPublish) {
      this.failNextLocalPublish = false;
      throw new SFUError("local publish failed", "signaling_failed");
    }
    if (this.localPublishFailure) throw this.localPublishFailure;
    if (this.nextLocalPublishFailure) {
      const failure = this.nextLocalPublishFailure;
      this.nextLocalPublishFailure = null;
      throw failure;
    }
    if (this.failNextStaleLocalPublish) {
      this.failNextStaleLocalPublish = false;
      throw new SFUError("stale local publish failed", "signaling_failed", { status: 410, retryableConnection: true });
    }
  }
  #pullRemote(input: Parameters<SFUSignalingTransport["addTracks"]>[0]): SFUTracksResponse {
    this.#throwQueuedRemotePullFailure();
    const tracks = input.tracks.filter((track) => !this.omittedRemoteTrackNames.has(track.trackName) && !this.failedRemoteTrackNames.has(track.trackName)).map((track, index) => ({ ...track, mid: this.reuseRemoteMids.shift() ?? `remote-${this.uniqueRemoteMids ? this.#nextRemoteMid++ : index}` }));
    const trackErrors = input.tracks.flatMap((track) => {
      const code = this.failedRemoteTrackNames.get(track.trackName);
      return code && track.sessionId ? [{ connectionId: track.sessionId, trackName: track.trackName, code }] : [];
    });
    if (this.reverseRemoteTracks) tracks.reverse();
    tracks.forEach((track, index) => this.#peer()?.emitTrack(track.mid, new FakeTrack(`pulled-${track.trackName}-${this.uniqueRemoteMids ? track.mid : index}`, track.trackName.includes("microphone") || track.trackName.includes("audio") ? "audio" : "video")));
    const requiresImmediateRenegotiation = this.immediateRenegotiation || this.#peer()?.connectionState !== "connected";
    return {
      tracks,
      trackErrors,
      requiresImmediateRenegotiation,
      sessionDescription: requiresImmediateRenegotiation ? { type: "offer", sdp: this.remoteOfferSDP ?? "remote-offer" } : undefined,
    };
  }
  #publishLocal(input: Parameters<SFUSignalingTransport["addTracks"]>[0]): SFUTracksResponse {
    this.#throwQueuedLocalPublishFailure();
    const localMids = input.tracks.flatMap((track) => (track.location === "local" && track.mid !== undefined ? [track.mid] : []));
    const nextLocalMids = new Set([...this.#localMids, ...localMids]);
    if (this.maxLocalMids !== null && nextLocalMids.size > this.maxLocalMids) throw new SFUError("local media-section budget exceeded", "signaling_failed");
    for (const mid of localMids) this.#localMids.add(mid);
    const tracks = input.tracks.map((track) => ({ ...track, publicationId: versionedPublicationID(input.connectionId, track.mid ?? "", track.trackName) }));
    for (const track of tracks) {
      if (!track.source) continue;
      this.localPublications.set(track.publicationId, { participantId: "participant-1", source: track.source, publicationId: track.publicationId });
      this.#localPublicationRevision++;
    }
    return {
      sessionDescription: { type: "answer", sdp: `answer:${input.connectionId}` },
      tracks,
    };
  }
  async closeTracks(input: { readonly connectionId: string; readonly sessionDescription?: SFUSessionDescription; readonly tracks: readonly SFUCloseTrackRequest[]; readonly force: boolean }): Promise<SFUTracksResponse> {
    this.closeInputs.push(input);
    if (input.tracks.some((track) => track.source === "microphone")) this.log.push("close microphone");
    if (this.failCloseCount > 0) {
      this.failCloseCount--;
      throw new SFUError("close unavailable", "signaling_failed", { status: 503 });
    }
    for (const track of input.tracks) {
      if (this.localPublications.delete(track.publicationId)) this.#localPublicationRevision++;
    }
    return input.sessionDescription ? { sessionDescription: { type: "answer", sdp: "close-answer" } } : {};
  }
  readonly updateInputs: Parameters<NonNullable<SFUSignalingTransport["updateTracks"]>>[0][] = [];
  failTrackUpdates = false;
  trackUpdateGate: Promise<void> | null = null;
  /** While set, a track update waits for it; `log` shows whether a later call overtook it. */
  holdTrackUpdates: Promise<void> | null = null;
  /** Local-track calls in the order they reached the transport, and when an update returned. */
  readonly log: string[] = [];
  async updateTracks(input: Parameters<NonNullable<SFUSignalingTransport["updateTracks"]>>[0]): Promise<SFUTracksResponse> {
    this.updateInputs.push(input);
    const local = input.tracks.find((track) => track.location === "local");
    if (local) this.log.push(`update paused=${local.paused}`);
    if (this.holdTrackUpdates) await this.holdTrackUpdates;
    if (local) this.log.push(`update returned paused=${local.paused}`);
    await this.trackUpdateGate;
    if (this.failTrackUpdates) throw new SFUError("layer switch rejected", "signaling_failed");
    return { tracks: input.tracks };
  }
  async renegotiate(input: { readonly connectionId: string; readonly sessionDescription: SFUSessionDescription }): Promise<void> {
    this.renegotiateInputs.push(input);
    if (this.failRenegotiation) throw new SFUError("renegotiation failed", "signaling_failed");
  }
  async listPublications(): Promise<SFUPublicationSnapshot> {
    this.listPublicationCalls++;
    const next = this.publicationListSnapshots.shift();
    return next ?? this.#currentSnapshot();
  }
  #currentSnapshot(): SFUPublicationSnapshot {
    return { ...this.snapshot, sequence: this.snapshot.sequence + this.#localPublicationRevision, publications: [...this.snapshot.publications, ...this.localPublications.values()] };
  }
}
export class FakeTrack extends EventTarget {
  enabled = true;
  muted = false;
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
  getSettings(): MediaTrackSettings {
    return {};
  }
  async applyConstraints(): Promise<void> {}
  clone(): FakeTrack {
    const track = new FakeTrack(`${this.id}-clone`, this.kind);
    track.enabled = this.enabled;
    return track;
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

export interface HarnessOptions extends Pick<ConstructorParameters<typeof SFUClient>[0], "telemetry"> {
  readonly autoConnect?: boolean;
  /** Decides per peer, by creation index, whether it ever connects. */
  readonly connectsPeer?: (index: number) => boolean;
  readonly onError?: (error: unknown, binding: string) => void;
  readonly onDiagnostic?: (event: SFULocalOfferDiagnostic) => void;
  readonly onScreenEnded?: () => void;
  readonly replaceMediaConnection?: () => Promise<SFUBootstrap>;
  readonly pollIntervalMs?: number;
  readonly unreportedVideoTileWaitMs?: number;
  readonly onReceiveHealth?: (event: TransportDiagnostic) => void;
  readonly bootstrap?: SFUBootstrap;
  readonly onRemoteTrack?: (publication: { readonly source: string }) => void;
}

// Every harness client is stopped, and every global and mock restored, after each test, so a test body needs no try/finally.
const startedClients: SFUClient[] = [];
afterEach(() => {
  for (const client of startedClients.splice(0)) client.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A client over the fake transport and the fake peers that `createPeer` makes. */
export function createSfuHarness<Peer extends TransportPeer>(options: HarnessOptions, createPeer: (autoConnect: boolean) => Peer) {
  const peers: Peer[] = [];
  const transport = new FakeTransport(() => peers.at(-1));
  const peerConnectionFactory = vi.fn(() => {
    const peer = createPeer(options.connectsPeer?.(peers.length) ?? options.autoConnect ?? true);
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  });
  const client = new SFUClient({
    bootstrap: options.bootstrap ?? bootstrap("connection-1"),
    participantId: "participant-1",
    transport,
    replaceMediaConnection: options.replaceMediaConnection,
    pollIntervalMs: options.pollIntervalMs ?? 60000,
    // Most tests never report tiles and expect video in the first pull.
    unreportedVideoTileWaitMs: options.unreportedVideoTileWaitMs ?? 0,
    onError: options.onError,
    onDiagnostic: options.onDiagnostic,
    onScreenEnded: options.onScreenEnded,
    onReceiveHealth: options.onReceiveHealth,
    telemetry: options.telemetry,
    onRemoteTrack: options.onRemoteTrack,
    peerConnectionFactory,
  });
  startedClients.push(client);
  return { client, peers, transport, peerConnectionFactory };
}
