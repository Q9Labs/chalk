import type { V3ClientMediaPlane, V3MediaPlaneResult, V3MediaPlaneTarget, V3MediaPublication, V3MediaSource } from "../sync/v3-types";
import { comparePublicationCursor, parseCloudflareSFUPublicationID, publicationKey, requireDescription, requireSFUDescription, validatePublicationSnapshot, waitFor } from "./tracks";
import { CloudflareSFUError } from "./types";
import type {
  CloudflareSFUBootstrap,
  CloudflareSFUClientOptions,
  CloudflareSFUCloseTrackRequest,
  CloudflareSFUFailureCode,
  CloudflareSFULocalTrack,
  CloudflareSFUPublication,
  CloudflareSFUPublicationSnapshot,
  CloudflareSFURemoteTrack,
  CloudflareSFURestartOptions,
  CloudflareSFUSignalingTransport,
  CloudflareSFUSnapshot,
  CloudflareSFUTrackRequest,
  CloudflareSFUTracksResponse,
} from "./types";
import type { PublicationCursor } from "./tracks";

type LocalTrackState = {
  readonly source: V3MediaSource;
  readonly track: MediaStreamTrack;
  transceiver: RTCRtpTransceiver | null;
  providerPublicationId: string | null;
  desiredEnabled: boolean;
  enabled: boolean;
  endedListener: (() => void) | null;
};

const EMPTY_LOCAL: readonly CloudflareSFULocalTrack[] = Object.freeze([]);
const EMPTY_REMOTE: readonly CloudflareSFURemoteTrack[] = Object.freeze([]);

export class CloudflareSFUClient implements V3ClientMediaPlane {
  readonly #localListeners = new Set<(publications: readonly V3MediaPublication[]) => void>();
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onRemoteTrack: ((publication: CloudflareSFURemoteTrack) => void) | undefined;
  readonly #onScreenEnded: (() => void) | undefined;
  readonly #participantSessionId: string;
  readonly #peerConnectionFactory: ((configuration: RTCConfiguration) => RTCPeerConnection) | undefined;
  readonly #pollIntervalMs: number;
  readonly #remoteListeners = new Set<(publications: readonly V3MediaPublication[]) => void>();
  readonly #snapshotListeners = new Set<() => void>();
  readonly #localTracks = new Map<V3MediaSource, LocalTrackState>();
  readonly #remoteTracks = new Map<string, CloudflareSFURemoteTrack>();
  #bootstrap: CloudflareSFUBootstrap;
  #connection: RTCPeerConnection;
  #cursor: PublicationCursor | null = null;
  #generation = 0;
  #polling = false;
  #pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #sdpTail: Promise<void> = Promise.resolve();
  #snapshot: CloudflareSFUSnapshot;
  #started = false;
  #stopped = false;
  #transport: CloudflareSFUSignalingTransport | undefined;

  constructor(options: CloudflareSFUClientOptions) {
    validateClientOptions(options);
    this.#participantSessionId = options.participantSessionId;
    this.#bootstrap = options.bootstrap;
    this.#transport = options.transport;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#onError = options.onError;
    this.#onRemoteTrack = options.onRemoteTrack;
    this.#onScreenEnded = options.onScreenEnded;
    this.#peerConnectionFactory = options.peerConnectionFactory;
    this.#connection = this.#createPeerConnection(options.bootstrap);
    this.#snapshot = freezeSnapshot({
      connection: { phase: "idle", peerConnectionState: this.#connection.connectionState, iceConnectionState: this.#connection.iceConnectionState },
      cursor: null,
      localTracks: EMPTY_LOCAL,
      remoteTracks: EMPTY_REMOTE,
      failure: null,
    });
    this.#observeConnection(this.#connection, this.#generation);
  }

  getSnapshot(): CloudflareSFUSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  prepareLocalTrack(source: V3MediaSource, track: MediaStreamTrack): void {
    this.#requireActive();
    validateTrackSource(source, track);
    if (this.#localTracks.has(source)) throw new CloudflareSFUError(`A ${source} track is already prepared`, "media_failed");
    const state: LocalTrackState = { source, track, transceiver: null, providerPublicationId: null, desiredEnabled: false, enabled: false, endedListener: null };
    if (source === "screen") {
      state.endedListener = () => {
        if (this.#localTracks.get("screen") === state) this.#invokeListener(() => this.#onScreenEnded?.());
      };
      track.addEventListener("ended", state.endedListener);
    }
    this.#localTracks.set(source, state);
    this.#publishSnapshot();
    this.#emitLocal();
  }

  async clearPreparedLocalTrack(source: V3MediaSource): Promise<void> {
    const state = this.#localTracks.get(source);
    if (!state) return;
    if (state.enabled) await this.#setPreparedTrackEnabled(state, false);
    this.#removeOwnedLocalTrack(state);
    this.#localTracks.delete(source);
    this.#publishSnapshot();
    this.#emitLocal();
  }

  async start(localMedia: MediaStream): Promise<void> {
    if (this.#started) return;
    this.#requireActive();
    const tracks = localMedia.getTracks().filter((track) => track.kind === "audio" || track.kind === "video");
    for (const track of tracks) this.prepareLocalTrack(track.kind === "audio" ? "microphone" : "camera", track);

    const generation = this.#generation;
    this.#setPhase("connecting", null);
    await this.#activatePreparedTracks(
      [...this.#localTracks.values()].filter((state) => state.source !== "screen"),
      generation,
    );
  }

  async refreshRemotePublications(): Promise<void> {
    if (!this.#started || this.#stopped || this.#polling) return;
    this.#polling = true;
    const generation = this.#generation;
    try {
      const transport = this.#requireTransport();
      const authoritative = await transport.listPublications();
      this.#requireGeneration(generation);
      await this.#reconcileRemotePublications(authoritative, generation);
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#setFailure(error, "signaling_failed");
      throw error;
    } finally {
      if (generation === this.#generation) this.#polling = false;
    }
  }

  async setLocalPublicationTarget(target: V3MediaPlaneTarget): Promise<V3MediaPlaneResult> {
    if (target.participantSessionId !== this.#participantSessionId) return { outcome: "terminal_failure", errorCode: "invalid_participant" };
    if (this.#stopped) return { outcome: "terminal_failure", errorCode: "media_stopped" };
    const state = this.#localTracks.get(target.source);
    if (!state) return { outcome: "terminal_failure", errorCode: "source_unavailable" };
    if (state.enabled === target.enabled) return { outcome: "satisfied", errorCode: null };
    try {
      await this.#setPreparedTrackEnabled(state, target.enabled);
      return { outcome: "confirmed", errorCode: null };
    } catch (error) {
      if (!this.#stopped) this.#setFailure(error, "signaling_failed");
      return { outcome: "retryable_failure", errorCode: error instanceof CloudflareSFUError ? error.code : "media_failed" };
    }
  }

  observeLocalPublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.#localListeners.add(listener);
    this.#invokeListener(() => listener(this.#projectLocalPublications()));
    return () => this.#localListeners.delete(listener);
  }

  observeRemotePublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.#remoteListeners.add(listener);
    this.#invokeListener(() => listener(this.#projectRemotePublications()));
    return () => this.#remoteListeners.delete(listener);
  }

  async restart(input: CloudflareSFUBootstrap | CloudflareSFURestartOptions): Promise<void> {
    this.#requireActive();
    const options: CloudflareSFURestartOptions = "connectionId" in input ? { bootstrap: input } : input;
    validateBootstrap(options.bootstrap);
    const generation = ++this.#generation;
    this.#polling = false;
    this.#clearPoll();
    this.#disposeConnection(false);
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#bootstrap = options.bootstrap;
    if (options.transport) this.#transport = options.transport;
    this.#connection = this.#createPeerConnection(options.bootstrap);
    this.#observeConnection(this.#connection, generation);
    for (const state of this.#localTracks.values()) {
      state.transceiver = null;
      state.enabled = false;
    }
    const enabled = [...this.#localTracks.values()].filter((state) => state.desiredEnabled && state.track.readyState !== "ended");
    this.#setPhase("recovering", null);
    await this.#activatePreparedTracks(enabled, generation);
  }

  async #activatePreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    try {
      await this.#publishPreparedTracks(states, generation);
      this.#requireGeneration(generation);
      this.#started = true;
      this.#setPhase("live", null);
      await this.refreshRemotePublications();
      this.#schedulePoll();
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#setFailure(error, "media_failed");
      throw error;
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation++;
    this.#clearPoll();
    this.#polling = false;
    this.#disposeConnection(true);
    this.#clearRemoteTracks();
    for (const state of this.#localTracks.values()) this.#removeOwnedLocalTrack(state);
    this.#localTracks.clear();
    this.#transport = undefined;
    this.#started = false;
    this.#cursor = null;
    this.#publishSnapshot("stopped", null);
    this.#emitLocal();
    this.#emitRemote();
    this.#localListeners.clear();
    this.#remoteListeners.clear();
    this.#snapshotListeners.clear();
  }

  async #setPreparedTrackEnabled(state: LocalTrackState, enabled: boolean): Promise<void> {
    if (enabled) {
      state.desiredEnabled = true;
      state.track.enabled = true;
      try {
        await this.#publishPreparedTracks([state], this.#generation);
      } catch (error) {
        state.enabled = false;
        state.track.enabled = false;
        throw error;
      }
      return;
    }
    const transceiver = state.transceiver;
    state.desiredEnabled = false;
    state.track.enabled = false;
    try {
      if (transceiver?.mid !== null && transceiver?.mid !== undefined && state.providerPublicationId) {
        await this.#closeTracks([{ mid: transceiver.mid, source: state.source, publicationId: state.providerPublicationId }], this.#generation);
        await this.#retireLocalTransceiver(transceiver, state.track);
      }
    } catch (error) {
      state.desiredEnabled = true;
      state.track.enabled = true;
      throw error;
    }
    state.enabled = false;
    state.transceiver = null;
    this.#publishSnapshot();
    this.#emitLocal();
  }

  async #retireLocalTransceiver(transceiver: RTCRtpTransceiver, ownedTrack: MediaStreamTrack): Promise<void> {
    let retired = false;
    try {
      await transceiver.sender.replaceTrack(null);
      retired = true;
    } catch (error) {
      this.#reportError(error);
    }
    try {
      transceiver.stop();
      retired = true;
    } catch (error) {
      this.#reportError(error);
    }
    if (!retired) safeStopTrack(ownedTrack, this.#reportError.bind(this));
  }

  async #publishPreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    if (states.length === 0) return;
    const connection = this.#connection;
    const bootstrap = this.#bootstrap;
    await this.#serializeSDP(async () => {
      this.#requireGeneration(generation);
      const transceivers = states.map((state) => {
        const transceiver = connection.addTransceiver(state.track, { direction: "sendonly" });
        state.transceiver = transceiver;
        return { state, transceiver };
      });
      try {
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        const requests = transceivers.map(({ state, transceiver }): CloudflareSFUTrackRequest => {
          if (transceiver.mid === null) throw new CloudflareSFUError("Browser did not assign a media section", "media_failed");
          return { location: "local", mid: transceiver.mid, trackName: state.track.id, source: state.source };
        });
        const response = await this.#requireTransport().addTracks({ connectionId: bootstrap.connectionId, sessionDescription: requireDescription(offer), tracks: requests });
        this.#requireGeneration(generation);
        await connection.setRemoteDescription(requireSFUDescription(response.sessionDescription));
        this.#requireGeneration(generation);
        for (const { state, transceiver } of transceivers) {
          const authoritative = response.tracks?.find((track) => track.location === "local" && track.mid === transceiver.mid && track.source === state.source);
          if (!authoritative?.publicationId) throw new CloudflareSFUError("Chalk did not return an authoritative local publication ID", "invalid_publication");
          state.desiredEnabled = true;
          state.enabled = true;
          state.providerPublicationId = authoritative.publicationId;
        }
        this.#publishSnapshot();
        this.#emitLocal();
      } catch (error) {
        for (const { state, transceiver } of transceivers) {
          try {
            transceiver.stop();
          } catch (stopError) {
            this.#reportError(stopError);
          }
          if (state.transceiver === transceiver) state.transceiver = null;
        }
        throw error;
      }
    });
  }

  async #closeTracks(tracks: readonly CloudflareSFUCloseTrackRequest[], generation: number): Promise<void> {
    const connection = this.#connection;
    const connectionId = this.#bootstrap.connectionId;
    await this.#serializeSDP(async () => {
      this.#requireGeneration(generation);
      const response = await this.#requireTransport().closeTracks({ connectionId, tracks });
      this.#requireGeneration(generation);
      await this.#completeRenegotiation(response, connection, connectionId, generation);
    });
  }

  async #reconcileRemotePublications(authoritative: CloudflareSFUPublicationSnapshot, generation: number): Promise<void> {
    const cursor = validatePublicationSnapshot(authoritative);
    const ordering = comparePublicationCursor(this.#cursor, cursor);
    if (ordering !== "newer") return;

    const desired = desiredRemotePublications(authoritative.publications, this.#participantSessionId);
    const toPull = [...desired].filter(([key, publication]) => this.#remoteTracks.get(key)?.publicationId !== publication.publicationId).map(([, publication]) => publication);
    const pulled = await this.#pull(toPull, generation);
    this.#requireGeneration(generation);
    const next = reconcileRemoteTracks(desired, pulled, this.#remoteTracks);
    stopReplacedRemoteTracks(this.#remoteTracks, next, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    for (const [key, publication] of next) this.#remoteTracks.set(key, publication);
    this.#cursor = cursor;
    for (const publication of pulled) this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    this.#publishSnapshot();
    this.#emitRemote();
  }

  async #pull(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[]> {
    if (publications.length === 0) return [];
    const connection = this.#connection;
    const connectionId = this.#bootstrap.connectionId;
    return this.#serializeSDP(async () => {
      const requested = publications.map((publication) => {
        const reference = parseCloudflareSFUPublicationID(publication.publicationId);
        return { location: "remote" as const, sessionId: reference.sessionId, trackName: reference.trackName };
      });
      const received = new Map<string, MediaStreamTrack>();
      const onTrack = (event: RTCTrackEvent) => {
        if (event.transceiver.mid !== null) received.set(event.transceiver.mid, event.track);
      };
      connection.addEventListener("track", onTrack);
      try {
        this.#requireGeneration(generation);
        const response = await this.#requireTransport().addTracks({ connectionId, tracks: requested });
        this.#requireGeneration(generation);
        const responseTracks = response.tracks ?? [];
        await this.#completeRenegotiation(response, connection, connectionId, generation);
        await waitFor(() => responseTracks.every((track) => track.mid !== undefined && received.has(track.mid)), 5_000);
        this.#requireGeneration(generation);
        return publications.map((publication, index) => {
          const responseTrack = responseTracks[index];
          const track = responseTrack?.mid === undefined ? undefined : received.get(responseTrack.mid);
          if (!track) throw new CloudflareSFUError("A negotiated remote track did not arrive", "media_failed");
          return Object.freeze({ ...publication, track });
        });
      } catch (error) {
        for (const track of received.values()) safeStopTrack(track, this.#reportError.bind(this));
        throw error;
      } finally {
        connection.removeEventListener("track", onTrack);
      }
    });
  }

  async #completeRenegotiation(response: CloudflareSFUTracksResponse, connection: RTCPeerConnection, connectionId: string, generation: number): Promise<void> {
    if (!response.requiresImmediateRenegotiation) return;
    if (!response.sessionDescription) throw new CloudflareSFUError("Cloudflare did not return a remote-track offer", "signaling_failed");
    await connection.setRemoteDescription(response.sessionDescription);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await this.#requireTransport().renegotiate({ connectionId, sessionDescription: requireDescription(answer) });
    this.#requireGeneration(generation);
  }

  #serializeSDP<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#sdpTail.then(operation, operation);
    this.#sdpTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #observeConnection(connection: RTCPeerConnection, generation: number): void {
    const observe = () => {
      if (generation !== this.#generation || this.#stopped) return;
      const observation = observeConnectionState(connection.connectionState, connection.iceConnectionState, this.#started);
      if (observation) this.#publishSnapshot(observation.phase, observation.failure);
      else this.#publishSnapshot();
    };
    connection.addEventListener("connectionstatechange", observe);
    connection.addEventListener("iceconnectionstatechange", observe);
  }

  #createPeerConnection(bootstrap: CloudflareSFUBootstrap): RTCPeerConnection {
    const create = this.#peerConnectionFactory ?? ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
    return create({ iceServers: [{ urls: bootstrap.stunServer }], bundlePolicy: "max-bundle" });
  }

  #disposeConnection(stopSenders: boolean): void {
    if (stopSenders) {
      for (const sender of this.#connection.getSenders()) {
        if (sender.track) safeStopTrack(sender.track, this.#reportError.bind(this));
      }
    }
    for (const transceiver of this.#connection.getTransceivers()) {
      try {
        transceiver.stop();
      } catch (error) {
        this.#reportError(error);
      }
    }
    try {
      this.#connection.close();
    } catch (error) {
      this.#reportError(error);
    }
  }

  #removeOwnedLocalTrack(state: LocalTrackState): void {
    if (state.endedListener) state.track.removeEventListener("ended", state.endedListener);
    safeStopTrack(state.track, this.#reportError.bind(this));
    state.enabled = false;
    state.desiredEnabled = false;
    state.transceiver = null;
    state.endedListener = null;
  }

  #clearRemoteTracks(): void {
    for (const publication of this.#remoteTracks.values()) safeStopTrack(publication.track, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    this.#publishSnapshot();
    this.#emitRemote();
  }

  #schedulePoll(): void {
    if (this.#stopped || !this.#started || this.#pollTimer !== undefined) return;
    this.#pollTimer = globalThis.setTimeout(async () => {
      this.#pollTimer = undefined;
      try {
        await this.refreshRemotePublications();
      } catch (error) {
        this.#reportError(error);
      } finally {
        this.#schedulePoll();
      }
    }, this.#pollIntervalMs);
  }

  #clearPoll(): void {
    if (this.#pollTimer !== undefined) globalThis.clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  #projectLocalPublications(): readonly V3MediaPublication[] {
    return [...this.#localTracks.values()].map((state) => ({
      participantSessionId: this.#participantSessionId,
      source: state.source,
      enabled: state.enabled,
      publicationId: state.enabled ? state.providerPublicationId : null,
    }));
  }

  #projectRemotePublications(): readonly V3MediaPublication[] {
    return [...this.#remoteTracks.values()].map(({ participantSessionId, source, publicationId }) => ({ participantSessionId, source, publicationId, enabled: true }));
  }

  #publishSnapshot(phase = this.#snapshot.connection.phase, failure = this.#snapshot.failure): void {
    const next = freezeSnapshot({
      connection: {
        phase,
        peerConnectionState: this.#connection.connectionState,
        iceConnectionState: this.#connection.iceConnectionState,
      },
      cursor: this.#cursor ? { incarnation: this.#cursor.incarnation, sequence: this.#cursor.sequence } : null,
      localTracks: this.#localTracks.size
        ? [...this.#localTracks.values()].map((state) =>
            Object.freeze({
              source: state.source,
              enabled: state.enabled,
              publicationId: state.enabled ? state.providerPublicationId : null,
              track: state.track,
            }),
          )
        : EMPTY_LOCAL,
      remoteTracks: this.#remoteTracks.size ? [...this.#remoteTracks.values()] : EMPTY_REMOTE,
      failure,
    });
    if (snapshotEqual(this.#snapshot, next)) return;
    this.#snapshot = next;
    for (const listener of this.#snapshotListeners) this.#invokeListener(listener);
  }

  #setPhase(phase: CloudflareSFUSnapshot["connection"]["phase"], failure: CloudflareSFUSnapshot["failure"]): void {
    this.#publishSnapshot(phase, failure);
  }

  #setFailure(error: unknown, fallback: CloudflareSFUFailureCode): void {
    const code = error instanceof CloudflareSFUError ? error.code : fallback;
    this.#publishSnapshot("failed", { code, recoverable: code !== "invalid_bootstrap" && code !== "invalid_target" && code !== "invalid_publication" });
    this.#reportError(error);
  }

  #emitLocal(): void {
    const publications = this.#projectLocalPublications();
    for (const listener of this.#localListeners) this.#invokeListener(() => listener(publications));
  }

  #emitRemote(): void {
    const publications = this.#projectRemotePublications();
    for (const listener of this.#remoteListeners) this.#invokeListener(() => listener(publications));
  }

  #invokeListener(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      this.#reportError(error);
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Consumer callbacks cannot prevent SFU cleanup or state reconciliation.
    }
  }

  #requireGeneration(generation: number): void {
    if (generation !== this.#generation || this.#stopped) throw new CloudflareSFUError("Cloudflare SFU operation belongs to a stale connection generation", "stale_generation");
  }

  #requireActive(): void {
    if (this.#stopped) throw new CloudflareSFUError("Cloudflare SFU client is stopped", "media_failed");
  }

  #requireTransport(): CloudflareSFUSignalingTransport {
    if (!this.#transport) throw new CloudflareSFUError("Cloudflare SFU signaling transport is unavailable", "signaling_failed");
    return this.#transport;
  }
}

function validateClientOptions(options: CloudflareSFUClientOptions): void {
  validateBootstrap(options.bootstrap);
  if (!options.participantSessionId.trim()) throw new CloudflareSFUError("Cloudflare SFU participant is missing", "invalid_bootstrap");
  if (options.pollIntervalMs !== undefined && (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0)) {
    throw new CloudflareSFUError("Cloudflare SFU polling interval is invalid", "invalid_bootstrap");
  }
}

function validateBootstrap(bootstrap: CloudflareSFUBootstrap): void {
  if (!bootstrap.connectionId.trim() || !bootstrap.stunServer.trim()) throw new CloudflareSFUError("Cloudflare SFU bootstrap is incomplete", "invalid_bootstrap");
}

function validateTrackSource(source: V3MediaSource, track: MediaStreamTrack): void {
  const valid = source === "microphone" ? track.kind === "audio" : track.kind === "video";
  if (!valid) throw new CloudflareSFUError(`The prepared ${source} track has an incompatible kind`, "media_failed");
}

function desiredRemotePublications(publications: readonly CloudflareSFUPublication[], participantSessionId: string): Map<string, CloudflareSFUPublication> {
  return new Map(publications.filter((publication) => publication.participantSessionId !== participantSessionId).map((publication) => [publicationKey(publication), publication]));
}

function reconcileRemoteTracks(desired: ReadonlyMap<string, CloudflareSFUPublication>, pulled: readonly CloudflareSFURemoteTrack[], current: ReadonlyMap<string, CloudflareSFURemoteTrack>): Map<string, CloudflareSFURemoteTrack> {
  const pulledByKey = new Map(pulled.map((publication) => [publicationKey(publication), publication]));
  return new Map(
    [...desired].map(([key, publication]) => {
      const track = pulledByKey.get(key) ?? current.get(key);
      if (!track || track.publicationId !== publication.publicationId) throw new CloudflareSFUError("Cloudflare SFU did not return a requested remote track", "media_failed");
      return [key, track];
    }),
  );
}

function stopReplacedRemoteTracks(current: ReadonlyMap<string, CloudflareSFURemoteTrack>, next: ReadonlyMap<string, CloudflareSFURemoteTrack>, onError: (error: unknown) => void): void {
  for (const [key, previous] of current) {
    if (next.get(key) !== previous) safeStopTrack(previous.track, onError);
  }
}

function observeConnectionState(peerState: RTCPeerConnectionState, iceState: RTCIceConnectionState, started: boolean): (Pick<CloudflareSFUSnapshot, "failure"> & { readonly phase: CloudflareSFUSnapshot["connection"]["phase"] }) | null {
  if (peerState === "failed") return { phase: "failed", failure: { code: "peer_connection_failed", recoverable: true } };
  if (iceState === "failed") return { phase: "failed", failure: { code: "ice_connection_failed", recoverable: true } };
  if (peerState === "disconnected" || iceState === "disconnected") return { phase: "recovering", failure: null };
  if (started && peerState === "connected" && (iceState === "connected" || iceState === "completed")) return { phase: "live", failure: null };
  return null;
}

function safeStopTrack(track: MediaStreamTrack, onError: (error: unknown) => void): void {
  try {
    track.stop();
  } catch (error) {
    onError(error);
  }
}

function freezeSnapshot(snapshot: CloudflareSFUSnapshot): CloudflareSFUSnapshot {
  const failure = snapshot.failure ? Object.freeze(snapshot.failure) : null;
  return Object.freeze({
    ...snapshot,
    connection: Object.freeze(snapshot.connection),
    cursor: snapshot.cursor ? Object.freeze(snapshot.cursor) : null,
    localTracks: Object.freeze(snapshot.localTracks),
    remoteTracks: Object.freeze(snapshot.remoteTracks),
    failure,
  });
}

function snapshotEqual(left: CloudflareSFUSnapshot, right: CloudflareSFUSnapshot): boolean {
  return snapshotMetadataEqual(left, right) && left.localTracks.every((publication, index) => publicationEqual(publication, right.localTracks[index])) && left.remoteTracks.every((publication, index) => remotePublicationEqual(publication, right.remoteTracks[index]));
}

function snapshotMetadataEqual(left: CloudflareSFUSnapshot, right: CloudflareSFUSnapshot): boolean {
  return connectionEqual(left.connection, right.connection) && cursorEqual(left.cursor, right.cursor) && failureEqual(left.failure, right.failure) && left.localTracks.length === right.localTracks.length && left.remoteTracks.length === right.remoteTracks.length;
}

function connectionEqual(left: CloudflareSFUSnapshot["connection"], right: CloudflareSFUSnapshot["connection"]): boolean {
  return left.phase === right.phase && left.peerConnectionState === right.peerConnectionState && left.iceConnectionState === right.iceConnectionState;
}

function cursorEqual(left: CloudflareSFUSnapshot["cursor"], right: CloudflareSFUSnapshot["cursor"]): boolean {
  return left?.incarnation === right?.incarnation && left?.sequence === right?.sequence;
}

function failureEqual(left: CloudflareSFUSnapshot["failure"], right: CloudflareSFUSnapshot["failure"]): boolean {
  return left?.code === right?.code && left?.recoverable === right?.recoverable;
}

function publicationEqual(left: CloudflareSFULocalTrack, right: CloudflareSFULocalTrack | undefined): boolean {
  return right !== undefined && left.source === right.source && left.enabled === right.enabled && left.publicationId === right.publicationId && left.track === right.track;
}

function remotePublicationEqual(left: CloudflareSFURemoteTrack, right: CloudflareSFURemoteTrack | undefined): boolean {
  return right !== undefined && left.participantSessionId === right.participantSessionId && left.source === right.source && left.publicationId === right.publicationId && left.track === right.track;
}
