import { CloudflareSFUError, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUCloseTrackRequest, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription, CloudflareSFUSignalingTransport, CloudflareSFUTrackRequest, CloudflareSFUTracksResponse } from "./cloudflare-sfu";

/** The part of a fake peer connection that the fake transport drives when the SFU hands out a remote track. */
export interface TransportPeer {
  readonly connectionState: RTCPeerConnectionState;
  emitTrack(mid: string, track: FakeTrack): void;
}

export function bootstrap(connectionId: string): CloudflareSFUBootstrap {
  return { connectionId, stunServer: "stun:example.test" };
}
export function publicationSnapshot(incarnation: number, sequence: number, publicationId: string): CloudflareSFUPublicationSnapshot {
  return { incarnation, sequence, publications: [{ participantId: "participant-2", source: "camera", publicationId }] };
}
export function versionedPublicationID(connectionId: string, mid: string, trackName: string): string {
  const payload = JSON.stringify({ c: connectionId, m: mid, t: trackName, g: 1 });
  return `chalk_pub_v1.${globalThis.btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
export function fakeStream(...tracks: readonly FakeTrack[]): MediaStream {
  return { getTracks: () => tracks as unknown as MediaStreamTrack[] } as MediaStream;
}

export class FakeTransport implements CloudflareSFUSignalingTransport {
  uniqueRemoteMids = false;
  /** MIDs the SFU hands out again for the next pulls, as it does for a mid whose track was closed. */
  readonly reuseRemoteMids: string[] = [];
  /** The SDP of the SFU's offer after a pull. */
  remoteOfferSDP: string | undefined;
  #nextRemoteMid = 0;
  #localPublicationRevision = 0;
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
  uploadCallStats: CloudflareSFUSignalingTransport["uploadCallStats"];
  listSubscriptions: CloudflareSFUSignalingTransport["listSubscriptions"];
  readonly localPublications = new Map<string, CloudflareSFUPublicationSnapshot["publications"][number]>();
  failNextLocalPublish = false;
  nextLocalPublishFailure: Error | null = null;
  localPublishFailure: Error | null = null;
  failNextStaleLocalPublish = false;
  failNextRemotePull = false;
  failCloseCount = 0;
  readonly omittedRemoteTrackNames = new Set<string>();
  readonly failedRemoteTrackNames = new Map<string, string>();
  readonly #withdrawnRemoteTrackKeys = new Set<string>();
  readonly #withdrawnLocalPublications = new Set<string>();
  reverseRemoteTracks = false;
  failRemotePullCount = 0;
  readonly remotePullFailures: unknown[] = [];
  readonly renegotiateInputs: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }[] = [];
  failRenegotiation = false;
  immediateRenegotiation = false;
  listPublicationCalls = 0;
  readonly publicationListSnapshots: CloudflareSFUPublicationSnapshot[] = [];
  maxLocalMids: number | null = null;
  snapshot: CloudflareSFUPublicationSnapshot = { incarnation: 1, sequence: 0, publications: [] };
  readonly #blockedConnections = new Map<string, () => void>();
  readonly #localMids = new Set<string>();
  readonly #publicationListResolvers: (() => void)[] = [];
  readonly #peer: () => TransportPeer | undefined;
  constructor(peer: () => TransportPeer | undefined) {
    this.#peer = peer;
  }
  async addTracks(input: Parameters<CloudflareSFUSignalingTransport["addTracks"]>[0]): Promise<CloudflareSFUTracksResponse> {
    this.addInputs.push(input);
    const unblock = this.#blockedConnections.get(input.connectionId);
    if (unblock) await new Promise<void>((resolve) => this.#blockedConnections.set(input.connectionId, resolve));
    if (input.tracks.some((track) => track.location === "remote")) {
      if (this.remotePullFailures.length > 0) throw this.remotePullFailures.shift();
      if (this.failRemotePullCount > 0) {
        this.failRemotePullCount--;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      if (this.failNextRemotePull) {
        this.failNextRemotePull = false;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      const tracks = input.tracks
        .filter((track) => !this.omittedRemoteTrackNames.has(track.trackName) && !this.failedRemoteTrackNames.has(track.trackName) && !this.#withdrawnRemoteTrackKeys.has(`${track.sessionId}|${track.trackName}`))
        .map((track, index) => ({ ...track, mid: this.reuseRemoteMids.shift() ?? `remote-${this.uniqueRemoteMids ? this.#nextRemoteMid++ : index}` }));
      const trackErrors = input.tracks.flatMap((track) => {
        const code = this.failedRemoteTrackNames.get(track.trackName) ?? (this.#withdrawnRemoteTrackKeys.has(`${track.sessionId}|${track.trackName}`) ? "publication_unavailable" : undefined);
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
    if (this.failNextLocalPublish) {
      this.failNextLocalPublish = false;
      throw new CloudflareSFUError("local publish failed", "signaling_failed");
    }
    if (this.localPublishFailure) throw this.localPublishFailure;
    if (this.nextLocalPublishFailure) {
      const failure = this.nextLocalPublishFailure;
      this.nextLocalPublishFailure = null;
      throw failure;
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
      if (track.source) {
        this.localPublications.set(track.publicationId, { participantId: "participant-1", source: track.source, publicationId: track.publicationId });
        this.#withdrawnLocalPublications.delete(track.publicationId);
        this.#localPublicationRevision++;
      }
    }
    return {
      sessionDescription: { type: "answer", sdp: `answer:${input.connectionId}` },
      tracks,
    };
  }
  async closeTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUCloseTrackRequest[]; readonly force: boolean }): Promise<CloudflareSFUTracksResponse> {
    this.closeInputs.push(input);
    if (input.tracks.some((track) => track.source === "microphone")) this.log.push("close microphone");
    if (this.failCloseCount > 0) {
      this.failCloseCount--;
      throw new CloudflareSFUError("close unavailable", "signaling_failed", { status: 503 });
    }
    if (input.tracks.some((track) => this.#withdrawnLocalPublications.has(track.publicationId))) {
      throw new CloudflareSFUError("publication is no longer available", "signaling_failed", { status: 410 });
    }
    for (const track of input.tracks) {
      if (this.localPublications.delete(track.publicationId)) this.#localPublicationRevision++;
    }
    return input.sessionDescription ? { sessionDescription: { type: "answer", sdp: "close-answer" } } : {};
  }
  withdrawPublication(publicationId: string): void {
    const publication = this.localPublications.get(publicationId);
    if (!publication) return;
    const { connectionId, trackName } = parseCloudflareSFUPublicationID(publicationId);
    this.localPublications.delete(publicationId);
    this.#localPublicationRevision++;
    this.#withdrawnLocalPublications.add(publicationId);
    this.#withdrawnRemoteTrackKeys.add(`${connectionId}|${trackName}`);
  }
  readonly updateInputs: Parameters<NonNullable<CloudflareSFUSignalingTransport["updateTracks"]>>[0][] = [];
  failTrackUpdates = false;
  trackUpdateGate: Promise<void> | null = null;
  /** While set, a track update waits for it; `log` shows whether a later call overtook it. */
  holdTrackUpdates: Promise<void> | null = null;
  /** Local-track calls in the order they reached the transport, and when an update returned. */
  readonly log: string[] = [];
  async updateTracks(input: Parameters<NonNullable<CloudflareSFUSignalingTransport["updateTracks"]>>[0]): Promise<CloudflareSFUTracksResponse> {
    this.updateInputs.push(input);
    const local = input.tracks.find((track) => track.location === "local");
    if (local) this.log.push(`update paused=${local.paused}`);
    if (this.holdTrackUpdates) await this.holdTrackUpdates;
    if (local) this.log.push(`update returned paused=${local.paused}`);
    await this.trackUpdateGate;
    if (this.failTrackUpdates) throw new CloudflareSFUError("layer switch rejected", "signaling_failed");
    return { tracks: input.tracks };
  }
  async renegotiate(input: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }): Promise<void> {
    this.renegotiateInputs.push(input);
    if (this.failRenegotiation) throw new CloudflareSFUError("renegotiation failed", "signaling_failed");
  }
  pullPublishedCalls = 0;
  async pullPublishedAudio(input: { readonly connectionId: string }): ReturnType<NonNullable<CloudflareSFUSignalingTransport["pullPublishedAudio"]>> {
    this.pullPublishedCalls++;
    const snapshot = this.#currentSnapshot();
    const audio = snapshot.publications.filter((publication) => publication.participantId !== "participant-1" && (publication.source === "microphone" || publication.source === "screen_audio"));
    if (audio.length === 0) return { snapshot, response: {} };
    const tracks = audio.map((publication): CloudflareSFUTrackRequest => {
      const { connectionId, trackName } = parseCloudflareSFUPublicationID(publication.publicationId);
      return { location: "remote", sessionId: connectionId, trackName };
    });
    return { snapshot, response: await this.addTracks({ connectionId: input.connectionId, tracks, allowPartialRemoteTracks: true }) };
  }
  async listPublications(): Promise<CloudflareSFUPublicationSnapshot> {
    this.listPublicationCalls++;
    const next = this.publicationListSnapshots.shift();
    if (this.blockPublicationList) await new Promise<void>((resolve) => this.#publicationListResolvers.push(resolve));
    return next ?? this.#currentSnapshot();
  }
  #currentSnapshot(): CloudflareSFUPublicationSnapshot {
    return { ...this.snapshot, sequence: this.snapshot.sequence + this.#localPublicationRevision, publications: [...this.snapshot.publications, ...this.localPublications.values()] };
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
