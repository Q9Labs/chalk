import type { CloudflareSFUBootstrap, CloudflareSFULocalTrack, CloudflareSFURemoteTrack, CloudflareSFUSnapshot, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaPublicationSource, MediaSource } from "@q9labsai/chalk-client";
import { CloudflareSFUError } from "@q9labsai/chalk-client";

import type { ServerMessage } from "./protocol";
import { registerPeer, registerSocket, releasePeer, releaseTrack } from "./resource-ledger";

type PeerState = {
  readonly connection: RTCPeerConnection;
  readonly senders: Map<MediaSource, RTCRtpSender>;
  readonly remoteByMid: Map<string, MediaSource>;
  makingOffer: boolean;
};

type FixtureMediaClientInput = {
  readonly access: {
    readonly subject: { readonly participantId: string };
    readonly media: FixtureMediaAccess;
  };
  readonly credential: () => Promise<string>;
  readonly onFailure: (error: unknown) => void;
  readonly onScreenEnded: () => void;
};

type FixtureMediaAccess =
  | { readonly token: string; readonly expiresAt: string; readonly provider: "cloudflare_sfu"; readonly clientPayload: CloudflareSFUBootstrap }
  | { readonly token: string; readonly expiresAt: string; readonly provider: "cloudflare_rtk"; readonly clientPayload: { readonly providerSubject: string; readonly token: string } };

export class FixtureMediaClient {
  readonly #credential: () => Promise<string>;
  readonly #listeners = new Set<() => void>();
  readonly #localListeners = new Set<(items: readonly MediaPublication[]) => void>();
  readonly #remoteListeners = new Set<(items: readonly MediaPublication[]) => void>();
  readonly #local = new Map<MediaSource, { track: MediaStreamTrack; enabled: boolean }>();
  readonly #onFailure: (error: unknown) => void;
  readonly #onScreenEnded: () => void;
  readonly #participantId: string;
  readonly #peers = new Map<string, PeerState>();
  readonly #received = new Map<string, CloudflareSFURemoteTrack>();
  readonly #signalingURL: string;
  #bootstrap: CloudflareSFUBootstrap;
  #remotePublications: readonly MediaPublication[] = [];
  #snapshot: CloudflareSFUSnapshot;
  #socket: WebSocket | null = null;

  constructor(signalingURL: string, input: FixtureMediaClientInput) {
    this.#signalingURL = signalingURL;
    this.#participantId = input.access.subject.participantId;
    if (input.access.media.provider !== "cloudflare_sfu") throw new TypeError("The fixture media client only supports Cloudflare SFU access");
    this.#bootstrap = input.access.media.clientPayload;
    this.#credential = input.credential;
    this.#onFailure = input.onFailure;
    this.#onScreenEnded = input.onScreenEnded;
    this.#snapshot = this.#makeSnapshot("idle", null);
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => (this.#listeners.add(listener), () => this.#listeners.delete(listener));

  // This consumer checks the packed SDK's published sources; shared tab audio is
  // proved by scripts/dev/share-audio-proof.mjs, so the fake doesn't send it.
  prepareLocalTrack(source: MediaPublicationSource, track: MediaStreamTrack): void {
    if (source === "screen_audio") return;
    this.#local.set(source, { track, enabled: false });
    if (source === "screen") track.addEventListener("ended", this.#onScreenEnded, { once: true });
    this.#publish();
  }

  async clearPreparedLocalTrack(source: MediaPublicationSource): Promise<void> {
    if (source === "screen_audio") return;
    const local = this.#local.get(source);
    if (!local) return;
    local.enabled = false;
    await this.#detachLocalTrack(source);
    releaseTrack(local.track);
    this.#local.delete(source);
    this.#sendPublications();
    await this.#renegotiateAll();
    this.#publish();
  }

  async #detachLocalTrack(source: MediaSource): Promise<void> {
    for (const peer of this.#peers.values()) {
      const sender = peer.senders.get(source);
      if (sender) await sender.replaceTrack(null);
    }
  }

  async start(stream: MediaStream): Promise<void> {
    for (const track of stream.getTracks()) this.prepareLocalTrack(track.kind === "audio" ? "microphone" : "camera", track);
    for (const local of this.#local.values()) local.enabled = true;
    this.#publish("connecting");
    await this.#connect();
    this.#sendPublications();
    this.#publish("live");
  }

  async restart(input: CloudflareSFUBootstrap | FixtureMediaAccess): Promise<void> {
    this.#bootstrap = fixtureBootstrap(input);
    this.#publish("recovering");
    this.#closeNetwork();
    try {
      await this.#connect();
    } catch (cause) {
      const status = cause instanceof CloudflareSFUError ? cause.options.status : undefined;
      this.#snapshot = this.#makeSnapshot("failed", { code: "signaling_failed", recoverable: status !== 401 && status !== 403 });
      this.#emit();
      throw cause;
    }
    this.#sendPublications();
    this.#publish("live");
  }

  stop = (): void => {
    this.#closeNetwork();
    for (const local of this.#local.values()) releaseTrack(local.track);
    for (const remote of this.#received.values()) releaseTrack(remote.track);
    this.#local.clear();
    this.#received.clear();
    this.#remotePublications = [];
    this.#publish("stopped");
    this.#listeners.clear();
    this.#localListeners.clear();
    this.#remoteListeners.clear();
  };

  async setLocalPublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    const local = this.#local.get(target.source);
    if (!local) return target.enabled ? { outcome: "terminal_failure", errorCode: "source_unavailable" } : { outcome: "satisfied", errorCode: null };
    if (local.enabled === target.enabled) return { outcome: "satisfied", errorCode: null };
    await this.#applyLocalTarget(target, local);
    this.#sendPublications();
    this.#publish();
    return { outcome: "confirmed", errorCode: null };
  }

  async #applyLocalTarget(target: MediaPlaneTarget, local: { track: MediaStreamTrack; enabled: boolean }): Promise<void> {
    local.enabled = target.enabled;
    local.track.enabled = target.enabled;
    if (!target.enabled) return;
    for (const peer of this.#peers.values()) await this.#addSender(peer, target.source, local.track);
    await this.#renegotiateAll();
  }

  observeLocalPublications(listener: (items: readonly MediaPublication[]) => void) {
    this.#localListeners.add(listener);
    listener(this.#localProjection());
    return () => this.#localListeners.delete(listener);
  }

  observeRemotePublications(listener: (items: readonly MediaPublication[]) => void) {
    this.#remoteListeners.add(listener);
    listener(this.#remotePublications);
    return () => this.#remoteListeners.delete(listener);
  }

  async #connect(): Promise<void> {
    const status = await fetch(`/test/media-recovery?participant=${encodeURIComponent(this.#participantId)}`);
    if (!status.ok) throw new CloudflareSFUError(`Fixture SFU HTTP ${status.status}`, "signaling_failed", { status: status.status, retryableConnection: status.status >= 500 });
    const token = await this.#credential();
    await new Promise<void>((resolve, reject) => {
      const socket = registerSocket(new WebSocket(`${this.#signalingURL}?token=${encodeURIComponent(token)}&connection=${encodeURIComponent(this.#bootstrap.connectionId)}`));
      this.#socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new TypeError("Fixture media signaling failed")), { once: true });
      socket.addEventListener("message", (event) => void this.#onMessage(JSON.parse(String(event.data)) as ServerMessage));
    });
  }

  async #onMessage(message: ServerMessage): Promise<void> {
    if (message.type === "signal") {
      await this.#handleSignal(message);
      return;
    }
    await this.#handleControlMessage(message);
  }

  async #handleControlMessage(message: Exclude<ServerMessage, { readonly type: "signal" }>): Promise<void> {
    if (message.type === "peers") {
      await this.#handlePeers(message.participants);
      return;
    }
    this.#handleStateOrFailure(message);
  }

  #handleStateOrFailure(message: Exclude<ServerMessage, { readonly type: "signal" | "peers" }>): void {
    if (message.type === "state") {
      this.#remotePublications = message.state.publications.filter((item) => item.participantId !== this.#participantId && item.enabled);
      this.#publish();
      for (const listener of this.#remoteListeners) listener(this.#remotePublications);
      return;
    }
    if (message.type === "force_failure") {
      this.#closeNetwork();
      this.#snapshot = this.#makeSnapshot("failed", { code: "peer_connection_failed", recoverable: true });
      this.#emit();
      this.#onFailure(new TypeError("Fixture forced media failure"));
    }
  }

  async #handlePeers(participants: readonly string[]): Promise<void> {
    const remotes = participants.filter((participant) => participant !== this.#participantId);
    await Promise.all(remotes.map((remote) => this.#connectPeer(remote)));
    for (const remote of [...this.#peers.keys()].filter((participant) => !remotes.includes(participant))) this.#removePeer(remote);
  }

  async #connectPeer(remote: string): Promise<void> {
    const peer = this.#ensurePeer(remote);
    if (this.#participantId < remote && !peer.makingOffer) await this.#negotiate(remote, peer);
  }

  async #handleSignal(message: Extract<ServerMessage, { readonly type: "signal" }>): Promise<void> {
    const peer = this.#ensurePeer(message.from);
    this.#recordRemoteMids(peer, message.mids);
    if (message.description) return this.#applyRemoteDescription(message.from, peer, message.description);
    if (message.candidate) await peer.connection.addIceCandidate(message.candidate);
  }

  #recordRemoteMids(peer: PeerState, mids: Readonly<Record<string, MediaSource>> | undefined): void {
    if (!mids) return;
    for (const [mid, source] of Object.entries(mids)) peer.remoteByMid.set(mid, source);
  }

  async #applyRemoteDescription(remote: string, peer: PeerState, description: RTCSessionDescriptionInit): Promise<void> {
    await peer.connection.setRemoteDescription(description);
    if (description.type !== "offer") return;
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    this.#sendSignal(remote, { description: peer.connection.localDescription!, mids: this.#localMids(peer) });
  }

  #ensurePeer(remote: string): PeerState {
    const existing = this.#peers.get(remote);
    if (existing) return existing;
    const connection = registerPeer(new RTCPeerConnection());
    const peer: PeerState = { connection, senders: new Map(), remoteByMid: new Map(), makingOffer: false };
    this.#peers.set(remote, peer);
    for (const [source, local] of this.#local) if (local.enabled) peer.senders.set(source, connection.addTrack(local.track, new MediaStream([local.track])));
    connection.addEventListener("icecandidate", (event) => this.#sendSignal(remote, { candidate: event.candidate?.toJSON() ?? null }));
    connection.addEventListener("track", (event) => {
      const mid = event.transceiver.mid;
      const source = (mid ? peer.remoteByMid.get(mid) : undefined) ?? (event.track.kind === "audio" ? "microphone" : "camera");
      recordFixtureRemoteTrack(this.#received, { participantId: remote, source, publicationId: `${remote}|${source}`, track: event.track });
      this.#publish();
    });
    return peer;
  }

  async #addSender(peer: PeerState, source: MediaSource, track: MediaStreamTrack): Promise<void> {
    const sender = peer.senders.get(source);
    if (sender) await sender.replaceTrack(track);
    else peer.senders.set(source, peer.connection.addTrack(track, new MediaStream([track])));
  }

  async #renegotiateAll(): Promise<void> {
    for (const [remote, peer] of this.#peers) if (this.#participantId < remote) await this.#negotiate(remote, peer);
  }

  async #negotiate(remote: string, peer: PeerState): Promise<void> {
    peer.makingOffer = true;
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      this.#sendSignal(remote, { description: peer.connection.localDescription!, mids: this.#localMids(peer) });
    } finally {
      peer.makingOffer = false;
    }
  }

  #localMids(peer: PeerState): Readonly<Record<string, MediaSource>> {
    return Object.fromEntries(
      [...peer.senders].flatMap(([source, sender]) => {
        const mid = peer.connection.getTransceivers().find((item) => item.sender === sender)?.mid;
        return mid ? [[mid, source]] : [];
      }),
    );
  }

  #sendSignal(to: string, value: Record<string, unknown>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify({ type: "signal", to, ...value }));
  }

  #sendPublications(): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ type: "publications", publications: this.#localProjection() }));
  }

  #localProjection(): readonly MediaPublication[] {
    return [...this.#local].map(([source, local]) => ({ participantId: this.#participantId, source, enabled: local.enabled, publicationId: local.enabled ? `${this.#bootstrap.connectionId}|${source}` : null }));
  }

  #removePeer(remote: string): void {
    const peer = this.#peers.get(remote);
    if (peer) releasePeer(peer.connection);
    this.#peers.delete(remote);
    for (const [key, track] of this.#received) if (key.startsWith(`${remote}:`)) (releaseTrack(track.track), this.#received.delete(key));
    this.#publish();
  }

  #closeNetwork(): void {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    for (const peer of this.#peers.values()) releasePeer(peer.connection);
    this.#peers.clear();
    for (const remote of this.#received.values()) releaseTrack(remote.track);
    this.#received.clear();
    this.#remotePublications = [];
  }

  #makeSnapshot(phase: CloudflareSFUSnapshot["connection"]["phase"], failure: CloudflareSFUSnapshot["failure"]): CloudflareSFUSnapshot {
    const localTracks: readonly CloudflareSFULocalTrack[] = [...this.#local].map(([source, local]) => ({ source, enabled: local.enabled, publicationId: local.enabled ? `${this.#bootstrap.connectionId}|${source}` : null, track: local.track }));
    const remoteTracks = projectFixtureRemoteTracks(this.#remotePublications, this.#received);
    return { connection: { phase, peerConnectionState: null, iceConnectionState: null }, cursor: null, localTracks, remoteTracks, failure };
  }

  #publish(phase = this.#snapshot.connection.phase): void {
    this.#snapshot = this.#makeSnapshot(phase, null);
    for (const listener of this.#localListeners) listener(this.#localProjection());
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function fixtureBootstrap(input: CloudflareSFUBootstrap | FixtureMediaAccess): CloudflareSFUBootstrap {
  if (!("provider" in input)) return input;
  if (input.provider !== "cloudflare_sfu") throw new TypeError("The fixture media client only supports Cloudflare SFU access");
  return input.clientPayload;
}

function recordFixtureRemoteTrack(received: Map<string, CloudflareSFURemoteTrack>, remote: CloudflareSFURemoteTrack): void {
  received.set(`${remote.participantId}:${remote.source}`, remote);
}

function projectFixtureRemoteTracks(remotePublications: readonly MediaPublication[], received: ReadonlyMap<string, CloudflareSFURemoteTrack>): readonly CloudflareSFURemoteTrack[] {
  // Projection can arrive after ontrack or disappear during a mute. Keep the
  // receiver owned by its peer; stopping it here permanently silences a reused
  // transceiver. Only expose tracks with a current physical publication.
  return remotePublications.flatMap((publication) => {
    if (!publication.enabled || !publication.publicationId) return [];
    const remote = received.get(`${publication.participantId}:${publication.source}`);
    return remote ? [{ ...remote, publicationId: publication.publicationId }] : [];
  });
}

export function bindFixtureMediaClient(client: FixtureMediaClient) {
  return {
    getSnapshot: client.getSnapshot,
    subscribe: client.subscribe,
    start: client.start.bind(client),
    stop: client.stop,
    restart: client.restart.bind(client),
    prepareLocalTrack: client.prepareLocalTrack.bind(client),
    clearPreparedLocalTrack: client.clearPreparedLocalTrack.bind(client),
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
  };
}
