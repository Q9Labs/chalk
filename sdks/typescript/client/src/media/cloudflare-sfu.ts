import type { V3ClientMediaPlane, V3MediaPlaneResult, V3MediaPlaneTarget, V3MediaPublication, V3MediaSource } from "../sync/v3-types";

export type CloudflareSFUBootstrap = {
  readonly connectionId: string;
  readonly stunServer: string;
};

export type CloudflareSFUSessionDescription = {
  readonly type: "offer" | "answer";
  readonly sdp: string;
};

export type CloudflareSFUTrackRequest = {
  readonly location: "local" | "remote";
  readonly mid?: string;
  readonly trackName: string;
  readonly sessionId?: string;
  readonly source?: V3MediaSource;
};

export type CloudflareSFUTracksResponse = {
  readonly sessionDescription?: CloudflareSFUSessionDescription;
  readonly tracks?: readonly CloudflareSFUTrackRequest[];
  readonly requiresImmediateRenegotiation?: boolean;
};

export type CloudflareSFUPublication = {
  readonly participantSessionId: string;
  readonly source: V3MediaSource;
  readonly publicationId: string;
};

export type CloudflareSFUPublicationSnapshot = {
  readonly incarnation: number;
  readonly sequence: number;
  readonly publications: readonly CloudflareSFUPublication[];
};

export type CloudflareSFUSignalingTransport = {
  readonly addTracks: (input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }) => Promise<CloudflareSFUTracksResponse>;
  readonly renegotiate: (input: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }) => Promise<void>;
  readonly listPublications: () => Promise<CloudflareSFUPublicationSnapshot>;
};

export type CloudflareSFURemoteTrack = CloudflareSFUPublication & {
  readonly track: MediaStreamTrack;
};

export type CloudflareSFUClientOptions = {
  readonly bootstrap: CloudflareSFUBootstrap;
  readonly participantSessionId: string;
  readonly transport: CloudflareSFUSignalingTransport;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly onRemoteTrack?: (publication: CloudflareSFURemoteTrack) => void;
  readonly peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
};

export type CloudflareSFUHTTPTransportOptions = {
  readonly apiBaseURL: string;
  readonly bearerToken: string;
  readonly tenantId: string;
  readonly roomId: string;
  readonly sessionId: string;
  readonly participantSessionId: string;
  readonly fetch?: typeof globalThis.fetch;
};

type LocalTransceiver = {
  readonly source: V3MediaSource;
  readonly track: MediaStreamTrack;
  readonly transceiver: RTCRtpTransceiver;
};

export class CloudflareSFUError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_bootstrap" | "invalid_publication" | "signaling_failed" | "media_failed",
  ) {
    super(message);
    this.name = "CloudflareSFUError";
  }
}

export class CloudflareSFUClient implements V3ClientMediaPlane {
  readonly #connection: RTCPeerConnection;
  readonly #localListeners = new Set<(publications: readonly V3MediaPublication[]) => void>();
  readonly #options: CloudflareSFUClientOptions;
  readonly #pulled = new Set<string>();
  readonly #remoteListeners = new Set<(publications: readonly V3MediaPublication[]) => void>();
  readonly #senders = new Map<V3MediaSource, RTCRtpSender>();
  #localPublications: readonly V3MediaPublication[] = [];
  #polling = false;
  #pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #remotePublications: readonly V3MediaPublication[] = [];
  #started = false;
  #stopped = false;

  constructor(options: CloudflareSFUClientOptions) {
    validateClientOptions(options);
    this.#options = options;
    this.#connection = createPeerConnection(options);
  }

  async start(localMedia: MediaStream): Promise<void> {
    if (!this.#canStart()) return;
    const transceivers = this.#addLocalTracks(localMedia);
    const offer = await this.#connection.createOffer();
    await this.#connection.setLocalDescription(offer);
    const response = await this.#options.transport.addTracks({
      connectionId: this.#options.bootstrap.connectionId,
      sessionDescription: requireDescription(offer),
      tracks: localTrackRequests(transceivers),
    });
    await this.#connection.setRemoteDescription(requireSFUDescription(response.sessionDescription));
    this.#localPublications = transceivers.map(({ source, track }) => ({
      participantSessionId: this.#options.participantSessionId,
      source,
      enabled: track.enabled,
      publicationId: `${this.#options.bootstrap.connectionId}|${track.id}`,
    }));
    this.#started = true;
    this.#emitLocal();
    await this.refreshRemotePublications();
    this.#schedulePoll();
  }

  async refreshRemotePublications(): Promise<void> {
    if (!this.#beginPoll()) return;
    try {
      const snapshot = await this.#options.transport.listPublications();
      this.#recordRemoteTracks(await this.#pullUnseen(snapshot.publications));
    } finally {
      this.#polling = false;
    }
  }

  async setLocalPublicationTarget(target: V3MediaPlaneTarget): Promise<V3MediaPlaneResult> {
    const sender = this.#senders.get(target.source);
    if (!sender?.track) return { outcome: "terminal_failure", errorCode: "source_unavailable" };
    sender.track.enabled = target.enabled;
    this.#localPublications = this.#localPublications.map((publication) => (publication.source === target.source ? { ...publication, enabled: target.enabled } : publication));
    this.#emitLocal();
    return { outcome: "confirmed", errorCode: null };
  }

  observeLocalPublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.#localListeners.add(listener);
    listener(this.#localPublications);
    return () => this.#localListeners.delete(listener);
  }

  observeRemotePublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.#remoteListeners.add(listener);
    listener(this.#remotePublications);
    return () => this.#remoteListeners.delete(listener);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#pollTimer !== undefined) globalThis.clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    for (const sender of this.#senders.values()) sender.track?.stop();
    this.#connection.close();
    this.#localListeners.clear();
    this.#remoteListeners.clear();
  }

  #canStart(): boolean {
    return !this.#started && !this.#stopped;
  }

  #addLocalTracks(localMedia: MediaStream): readonly LocalTransceiver[] {
    return requireLocalTracks(localMedia).map((track) => {
      const source: V3MediaSource = track.kind === "audio" ? "microphone" : "camera";
      const transceiver = this.#connection.addTransceiver(track, { direction: "sendonly" });
      this.#senders.set(source, transceiver.sender);
      return { source, track, transceiver };
    });
  }

  #beginPoll(): boolean {
    if (!this.#started || this.#stopped || this.#polling) return false;
    this.#polling = true;
    return true;
  }

  async #pullUnseen(publications: readonly CloudflareSFUPublication[]): Promise<readonly CloudflareSFURemoteTrack[]> {
    const unseen = publications.filter((publication) => publication.participantSessionId !== this.#options.participantSessionId && !this.#pulled.has(publication.publicationId));
    return unseen.length === 0 ? [] : this.#pull(unseen);
  }

  #recordRemoteTracks(remoteTracks: readonly CloudflareSFURemoteTrack[]): void {
    for (const publication of remoteTracks) {
      this.#pulled.add(publication.publicationId);
      this.#options.onRemoteTrack?.(publication);
    }
    this.#remotePublications = [...this.#remotePublications, ...remoteTracks.map(({ participantSessionId, source, publicationId }) => ({ participantSessionId, source, publicationId, enabled: true }))];
    this.#emitRemote();
  }

  async #pull(publications: readonly CloudflareSFUPublication[]): Promise<readonly CloudflareSFURemoteTrack[]> {
    const requested = publications.map((publication) => {
      const reference = parsePublicationID(publication.publicationId);
      return { location: "remote" as const, sessionId: reference.sessionId, trackName: reference.trackName };
    });
    const received = new Map<string, MediaStreamTrack>();
    const onTrack = (event: RTCTrackEvent) => {
      if (event.transceiver.mid !== null) received.set(event.transceiver.mid, event.track);
    };
    this.#connection.addEventListener("track", onTrack);
    try {
      const response = await this.#options.transport.addTracks({ connectionId: this.#options.bootstrap.connectionId, tracks: requested });
      const responseTracks = response.tracks ?? [];
      if (response.requiresImmediateRenegotiation) {
        if (!response.sessionDescription) throw new CloudflareSFUError("Cloudflare did not return a remote-track offer", "signaling_failed");
        await this.#connection.setRemoteDescription(response.sessionDescription);
        const answer = await this.#connection.createAnswer();
        await this.#connection.setLocalDescription(answer);
        await this.#options.transport.renegotiate({ connectionId: this.#options.bootstrap.connectionId, sessionDescription: requireDescription(answer) });
      }
      await waitFor(() => responseTracks.every((track) => track.mid !== undefined && received.has(track.mid)), 5_000);
      return publications.map((publication, index) => {
        const responseTrack = responseTracks[index];
        const track = responseTrack?.mid === undefined ? undefined : received.get(responseTrack.mid);
        if (!track) throw new CloudflareSFUError("A negotiated remote track did not arrive", "media_failed");
        return { ...publication, track };
      });
    } finally {
      this.#connection.removeEventListener("track", onTrack);
    }
  }

  #schedulePoll(): void {
    if (this.#stopped) return;
    this.#pollTimer = globalThis.setTimeout(async () => {
      try {
        await this.refreshRemotePublications();
      } catch (error) {
        this.#options.onError?.(error);
      } finally {
        this.#schedulePoll();
      }
    }, this.#options.pollIntervalMs ?? 1_000);
  }

  #emitLocal(): void {
    for (const listener of this.#localListeners) listener(this.#localPublications);
  }

  #emitRemote(): void {
    for (const listener of this.#remoteListeners) listener(this.#remotePublications);
  }
}

export function createCloudflareSFUHTTPTransport(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUSignalingTransport {
  const fetch = options.fetch ?? globalThis.fetch;
  const base = options.apiBaseURL.replace(/\/$/, "");
  const mediaPath = `${base}/v1/tenants/${encodeURIComponent(options.tenantId)}/rooms/${encodeURIComponent(options.roomId)}/sessions/${encodeURIComponent(options.sessionId)}/participants/${encodeURIComponent(options.participantSessionId)}/media/sfu`;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${mediaPath}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${options.bearerToken}`, "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) throw new CloudflareSFUError(`Chalk SFU signaling failed with HTTP ${response.status}`, "signaling_failed");
    return (await response.json()) as T;
  };
  return {
    addTracks: async (input) =>
      request<CloudflareSFUTracksResponse>("tracks", {
        method: "POST",
        body: JSON.stringify({ connection_id: input.connectionId, session_description: input.sessionDescription, tracks: input.tracks }),
      }),
    renegotiate: async (input) => {
      await request("renegotiate", {
        method: "POST",
        body: JSON.stringify({ connection_id: input.connectionId, session_description: input.sessionDescription }),
      });
    },
    listPublications: async () => {
      const response = await request<{
        incarnation: number;
        sequence: number;
        publications: readonly { participant_session_id: string; source: V3MediaSource; publication_id: string }[];
      }>("publications");
      return {
        incarnation: response.incarnation,
        sequence: response.sequence,
        publications: response.publications.map((publication) => ({
          participantSessionId: publication.participant_session_id,
          source: publication.source,
          publicationId: publication.publication_id,
        })),
      };
    },
  };
}

export function parseCloudflareSFUPublicationID(publicationId: string): { readonly sessionId: string; readonly trackName: string } {
  return parsePublicationID(publicationId);
}

function validateClientOptions(options: CloudflareSFUClientOptions): void {
  const required = [options.bootstrap.connectionId, options.bootstrap.stunServer, options.participantSessionId];
  if (required.some((value) => !value.trim())) throw new CloudflareSFUError("Cloudflare SFU bootstrap is incomplete", "invalid_bootstrap");
}

function createPeerConnection(options: CloudflareSFUClientOptions): RTCPeerConnection {
  const create = options.peerConnectionFactory ?? ((configuration) => new RTCPeerConnection(configuration));
  return create({ iceServers: [{ urls: options.bootstrap.stunServer }], bundlePolicy: "max-bundle" });
}

function requireLocalTracks(localMedia: MediaStream): readonly MediaStreamTrack[] {
  const tracks = localMedia.getTracks().filter((track) => track.kind === "audio" || track.kind === "video");
  if (tracks.length === 0) throw new CloudflareSFUError("No camera or microphone tracks are available", "media_failed");
  return tracks;
}

function localTrackRequests(transceivers: readonly LocalTransceiver[]): readonly CloudflareSFUTrackRequest[] {
  return transceivers.map(({ source, track, transceiver }) => {
    if (transceiver.mid === null) throw new CloudflareSFUError("Browser did not assign a media section", "media_failed");
    return { location: "local", mid: transceiver.mid, trackName: track.id, source };
  });
}

function requireSFUDescription(description: CloudflareSFUSessionDescription | undefined): CloudflareSFUSessionDescription {
  if (!description) throw new CloudflareSFUError("Cloudflare did not return an SDP answer", "signaling_failed");
  return description;
}

function parsePublicationID(publicationId: string): { readonly sessionId: string; readonly trackName: string } {
  const separator = publicationId.indexOf("|");
  if (separator <= 0 || separator === publicationId.length - 1 || publicationId.indexOf("|", separator + 1) !== -1) {
    throw new CloudflareSFUError("Cloudflare SFU publication ID is malformed", "invalid_publication");
  }
  return { sessionId: publicationId.slice(0, separator), trackName: publicationId.slice(separator + 1) };
}

function requireDescription(description: RTCSessionDescriptionInit): CloudflareSFUSessionDescription {
  if ((description.type !== "offer" && description.type !== "answer") || !description.sdp) {
    throw new CloudflareSFUError("Browser SDP description is incomplete", "media_failed");
  }
  return { type: description.type, sdp: description.sdp };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new CloudflareSFUError("Timed out waiting for a remote media track", "media_failed");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
}
