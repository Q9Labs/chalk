import type { ClientMediaPlane, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaSource } from "./plane";
import { subscribeSnapshot } from "./observers";
import { resolveMediaTarget } from "./target";
import { comparePublicationCursor, parseCloudflareSFUPublicationID, publicationKey, requireDescription, requireSFUDescription, validatePublicationSnapshot, waitFor } from "./tracks";
import { CloudflareSFUError } from "./types";
import type {
  CloudflareSFUBootstrap,
  CloudflareSFUClientOptions,
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
  readonly source: MediaSource;
  readonly track: MediaStreamTrack;
  publicationTrack: MediaStreamTrack | null;
  transceiver: RTCRtpTransceiver | null;
  providerPublicationId: string | null;
  pendingOperationId: string | null;
  pendingOperationToken: number | null;
  pendingTrackName: string | null;
  desiredEnabled: boolean;
  enabled: boolean;
  endedListener: (() => void) | null;
};

type PendingLocalPublication = {
  readonly state: LocalTrackState;
  readonly publicationTrack: MediaStreamTrack;
  readonly transceiver: RTCRtpTransceiver;
  readonly trackName: string;
  readonly operationToken: number | null;
};

interface RemoteTrackPullRequest extends CloudflareSFUTrackRequest {
  readonly location: "remote";
  readonly sessionId: string;
  readonly trackName: string;
}

type InternalRemoteTrack = CloudflareSFURemoteTrack & {
  readonly transceiver: RTCRtpTransceiver;
};

const EMPTY_LOCAL: readonly CloudflareSFULocalTrack[] = Object.freeze([]);
const EMPTY_REMOTE: readonly CloudflareSFURemoteTrack[] = Object.freeze([]);
const CONNECTION_TIMEOUT_MS = 8_000;
const REMOTE_TRACK_UNMUTE_TIMEOUT_MS = 2_000;
const MAX_REMOTE_POLL_BACKOFF_EXPONENT = 2;

export class CloudflareSFUClient implements ClientMediaPlane {
  readonly #localListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onRemoteTrack: ((publication: CloudflareSFURemoteTrack) => void) | undefined;
  readonly #onScreenEnded: (() => void) | undefined;
  readonly #participantId: string;
  readonly #peerConnectionFactory: ((configuration: RTCConfiguration) => RTCPeerConnection) | undefined;
  readonly #pollIntervalMs: number;
  readonly #remoteListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #snapshotListeners = new Set<() => void>();
  readonly #localTracks = new Map<MediaSource, LocalTrackState>();
  readonly #remoteTracks = new Map<string, InternalRemoteTrack>();
  #bootstrap: CloudflareSFUBootstrap;
  #connection: RTCPeerConnection;
  #cursor: PublicationCursor | null = null;
  #generation = 0;
  #nextOperationToken = 0;
  #polling = false;
  #pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #failedRemoteCursor: PublicationCursor | null = null;
  #failedRemotePullAttempts = 0;
  #sdpTail: Promise<void> = Promise.resolve();
  #sdpTailGeneration = 0;
  #snapshot: CloudflareSFUSnapshot;
  #started = false;
  #stopped = false;
  #transport: CloudflareSFUSignalingTransport | undefined;

  constructor(options: CloudflareSFUClientOptions) {
    validateClientOptions(options);
    this.#participantId = options.participantId;
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
    return subscribeSnapshot(this.#snapshotListeners, listener);
  }

  prepareLocalTrack(source: MediaSource, track: MediaStreamTrack): void {
    this.#requireActive();
    validateTrackSource(source, track);
    if (this.#localTracks.has(source)) throw new CloudflareSFUError(`A ${source} track is already prepared`, "media_failed");
    const state: LocalTrackState = {
      source,
      track,
      publicationTrack: null,
      transceiver: null,
      providerPublicationId: null,
      pendingOperationId: null,
      pendingOperationToken: null,
      pendingTrackName: null,
      desiredEnabled: false,
      enabled: false,
      endedListener: null,
    };
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

  async clearPreparedLocalTrack(source: MediaSource): Promise<void> {
    const state = this.#localTracks.get(source);
    if (!state) return;
    if (state.enabled) await this.#setPreparedTrackEnabled(state, false);
    if (state.source === "screen") state.transceiver?.stop();
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
      if (generation === this.#generation && !this.#stopped) this.#reportError(error);
      throw error;
    } finally {
      if (generation === this.#generation) this.#polling = false;
    }
  }

  async setLocalPublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind === "result") return resolved.result;
    const state = resolved.value;
    if (state.enabled === target.enabled) return { outcome: "satisfied", errorCode: null };
    try {
      await this.#setPreparedTrackEnabled(state, target.enabled, target.operationId);
      return { outcome: "confirmed", errorCode: null };
    } catch (error) {
      if (!this.#stopped && !(error instanceof CloudflareSFUError && error.code === "connection_retired")) this.#reportError(error);
      return { outcome: "retryable_failure", errorCode: error instanceof CloudflareSFUError ? error.code : "media_failed" };
    }
  }

  observeLocalPublications(listener: (publications: readonly MediaPublication[]) => void): () => void {
    this.#localListeners.add(listener);
    this.#invokeListener(() => listener(this.#projectLocalPublications()));
    return () => this.#localListeners.delete(listener);
  }

  observeRemotePublications(listener: (publications: readonly MediaPublication[]) => void): () => void {
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
    this.#clearRemotePollBackoff();
    this.#disposeConnection(false);
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#bootstrap = options.bootstrap;
    if (options.transport) this.#transport = options.transport;
    this.#connection = this.#createPeerConnection(options.bootstrap);
    this.#observeConnection(this.#connection, generation);
    for (const state of this.#localTracks.values()) {
      if (state.publicationTrack) safeStopTrack(state.publicationTrack, this.#reportError.bind(this));
      state.publicationTrack = null;
      state.transceiver = null;
      state.enabled = false;
      state.providerPublicationId = null;
      state.pendingOperationToken = state.desiredEnabled ? ++this.#nextOperationToken : null;
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
      this.#schedulePoll(0);
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

  async #setPreparedTrackEnabled(state: LocalTrackState, enabled: boolean, operationId?: string): Promise<void> {
    if (enabled) return this.#enablePreparedTrack(state, operationId);
    return this.#disablePreparedTrack(state);
  }

  #beginEnableOperation(state: LocalTrackState, operationId: string | undefined): number {
    if (operationId && state.pendingOperationId === operationId && state.pendingOperationToken !== null) return state.pendingOperationToken;
    const token = ++this.#nextOperationToken;
    state.pendingOperationToken = token;
    if (operationId && state.pendingOperationId !== operationId) {
      state.pendingOperationId = operationId;
      state.pendingTrackName = `${state.source}-${operationId}`;
    }
    return token;
  }

  async #enablePreparedTrack(state: LocalTrackState, operationId?: string): Promise<void> {
    const generation = this.#generation;
    const operationToken = this.#beginEnableOperation(state, operationId);
    state.desiredEnabled = true;
    state.track.enabled = true;
    if (this.#snapshot.connection.phase === "failed" && this.#snapshot.failure?.code === "connection_retired") {
      throw new CloudflareSFUError("The retired Cloudflare SFU connection is being replaced", "connection_retired");
    }
    if (this.#snapshot.connection.phase === "recovering") {
      throw new CloudflareSFUError("The recovering Cloudflare SFU connection is being replaced", "connection_retired");
    }
    if (this.#started && this.#snapshot.connection.phase === "live" && state.providerPublicationId === null) {
      this.#publishSnapshot("failed", { code: "connection_retired", recoverable: true });
      throw new CloudflareSFUError("The live Cloudflare SFU connection must be replaced before adding a local publication", "connection_retired");
    }
    try {
      await this.#publishPreparedTracks([state], generation);
      if (state.pendingOperationToken === operationToken && state.enabled) {
        state.pendingOperationId = null;
        state.pendingOperationToken = null;
        state.pendingTrackName = null;
      }
    } catch (error) {
      if (generation === this.#generation && state.pendingOperationToken === operationToken) {
        state.desiredEnabled = false;
        state.enabled = false;
        state.track.enabled = false;
      }
      throw error;
    }
  }

  async #disablePreparedTrack(state: LocalTrackState): Promise<void> {
    const transceiver = state.transceiver;
    state.desiredEnabled = false;
    state.track.enabled = false;
    try {
      if (transceiver) await transceiver.sender.replaceTrack(null);
    } catch (error) {
      state.desiredEnabled = true;
      state.track.enabled = true;
      throw error;
    }
    if (state.publicationTrack) safeStopTrack(state.publicationTrack, this.#reportError.bind(this));
    try {
      transceiver?.stop();
    } catch (error) {
      this.#reportError(error);
    }
    state.enabled = false;
    state.publicationTrack = null;
    state.transceiver = null;
    state.providerPublicationId = null;
    state.pendingOperationId = null;
    state.pendingOperationToken = null;
    state.pendingTrackName = null;
    this.#publishSnapshot();
    this.#emitLocal();
  }

  async #publishPreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    if (states.length === 0) return;
    const connection = this.#connection;
    const bootstrap = this.#bootstrap;
    await this.#serializeSDP(() => this.#publishPreparedTracksSerialized(states, generation, connection, bootstrap.connectionId), generation);
  }

  async #publishPreparedTracksSerialized(states: readonly LocalTrackState[], generation: number, connection: RTCPeerConnection, connectionId: string): Promise<void> {
    this.#requireGeneration(generation);
    const pendingStates = states.filter((state) => !state.enabled);
    if (pendingStates.length === 0) return;
    const wasLive = connectionIsLive(connection);
    const publications: PendingLocalPublication[] = [];
    try {
      for (const state of pendingStates) publications.push(await this.#prepareLocalPublication(connection, state));
      const response = await this.#negotiateLocalPublications(connection, connectionId, publications, generation);
      if (!wasLive) await this.#waitForConnection(connection, generation);
      this.#requireGeneration(generation);
      this.#confirmLocalPublications(publications, response.tracks);
      this.#publishSnapshot();
      this.#emitLocal();
    } catch (error) {
      await this.#rollbackLocalOffer(connection);
      await this.#discardLocalPublications(publications);
      throw error;
    }
  }

  async #prepareLocalPublication(connection: RTCPeerConnection, state: LocalTrackState): Promise<PendingLocalPublication> {
    const publicationTrack = state.track.clone();
    publicationTrack.enabled = true;
    const transceiver = connection.addTransceiver(publicationTrack, { direction: "sendonly" });
    state.publicationTrack = publicationTrack;
    state.transceiver = transceiver;
    return { state, publicationTrack, transceiver, trackName: state.pendingTrackName ?? `${state.source}-${globalThis.crypto.randomUUID()}`, operationToken: state.pendingOperationToken };
  }

  async #negotiateLocalPublications(connection: RTCPeerConnection, connectionId: string, publications: readonly PendingLocalPublication[], generation: number): Promise<CloudflareSFUTracksResponse> {
    const transport = this.#requireTransport();
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const response = await transport.addTracks({ connectionId, sessionDescription: requireDescription(offer), tracks: localTrackRequests(publications) });
    this.#requireGeneration(generation);
    await connection.setRemoteDescription(requireSFUDescription(response.sessionDescription));
    return response;
  }

  #confirmLocalPublications(publications: readonly PendingLocalPublication[], tracks: readonly CloudflareSFUTrackRequest[] | undefined): void {
    for (const { state, transceiver, operationToken } of publications) {
      const authoritative = tracks?.find((track) => track.location === "local" && track.mid === transceiver.mid && track.source === state.source);
      if (!authoritative?.publicationId) throw new CloudflareSFUError("Chalk did not return an authoritative local publication ID", "invalid_publication");
      state.desiredEnabled = true;
      state.enabled = true;
      state.providerPublicationId = authoritative.publicationId;
      if (state.pendingOperationToken === operationToken) {
        state.pendingOperationId = null;
        state.pendingOperationToken = null;
        state.pendingTrackName = null;
      }
    }
  }

  async #discardLocalPublications(publications: readonly PendingLocalPublication[]): Promise<void> {
    for (const { state, publicationTrack, transceiver } of publications) {
      try {
        transceiver.stop();
      } catch (error) {
        this.#reportError(error);
      }
      safeStopTrack(publicationTrack, this.#reportError.bind(this));
      if (state.transceiver === transceiver) state.transceiver = null;
      if (state.publicationTrack === publicationTrack) state.publicationTrack = null;
    }
  }

  async #rollbackLocalOffer(connection: RTCPeerConnection): Promise<void> {
    if (connection.signalingState !== "have-local-offer") return;
    try {
      await connection.setLocalDescription({ type: "rollback" });
    } catch (error) {
      this.#reportError(error);
    }
  }

  async #reconcileRemotePublications(authoritative: CloudflareSFUPublicationSnapshot, generation: number): Promise<void> {
    const cursor = validatePublicationSnapshot(authoritative);
    const ordering = comparePublicationCursor(this.#cursor, cursor);
    if (ordering !== "newer") return;

    const desired = desiredRemotePublications(authoritative.publications, this.#participantId);
    const toPull = [...desired].filter(([key, publication]) => this.#remoteTracks.get(key)?.publicationId !== publication.publicationId).map(([, publication]) => publication);
    let pulled: readonly InternalRemoteTrack[];
    try {
      pulled = await this.#pull(toPull, generation);
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#recordRemotePullFailure(cursor);
      throw error;
    }
    const complete = pulled.length === toPull.length;
    if (complete) this.#clearRemotePollBackoff();
    else this.#recordRemotePullFailure(cursor);
    this.#requireGeneration(generation);
    const next = reconcileRemoteTracks(desired, pulled, this.#remoteTracks, !complete);
    stopReplacedRemoteTracks(this.#remoteTracks, next, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    for (const [key, publication] of next) this.#remoteTracks.set(key, publication);
    if (complete) this.#cursor = cursor;
    for (const publication of pulled) this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    this.#publishSnapshot();
    this.#emitRemote();
  }

  async #pull(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly InternalRemoteTrack[]> {
    if (publications.length === 0) return [];
    const connection = this.#connection;
    const connectionId = this.#bootstrap.connectionId;
    return this.#serializeSDP(async () => {
      const pulls = publications.map((publication) => {
        const reference = parseCloudflareSFUPublicationID(publication.publicationId);
        const request: RemoteTrackPullRequest = { location: "remote", sessionId: reference.connectionId, trackName: reference.trackName };
        return {
          publication,
          request,
        };
      });
      const requested = pulls.map((pull) => pull.request);
      const received = new Map<string, { readonly track: MediaStreamTrack; readonly transceiver: RTCRtpTransceiver }>();
      const onTrack = (event: RTCTrackEvent) => {
        if (event.transceiver.mid !== null) received.set(event.transceiver.mid, { track: event.track, transceiver: event.transceiver });
      };
      connection.addEventListener("track", onTrack);
      try {
        this.#requireGeneration(generation);
        const response = await this.#requireTransport().addTracks({ connectionId, tracks: requested });
        this.#requireGeneration(generation);
        const responseTracks = response.tracks ?? [];
        const responseTracksByIdentity = requireRemoteTrackResponses(requested, responseTracks);
        await this.#completeRenegotiation(response, connection, connectionId, generation);
        await this.#waitForConnection(connection, generation);
        await waitFor(() => responseTracks.every((track) => track.mid !== undefined && received.has(track.mid)), 5_000);
        this.#requireGeneration(generation);
        const negotiated = pulls.flatMap(({ publication, request }) => {
          const responseTrack = responseTracksByIdentity.get(remoteTrackIdentity(request.sessionId, request.trackName));
          if (!responseTrack) return [];
          const receivedTrack = responseTrack?.mid === undefined ? undefined : received.get(responseTrack.mid);
          if (!receivedTrack) throw new CloudflareSFUError("A negotiated remote track did not arrive", "media_failed");
          validateRemoteTrackSource(publication.source, receivedTrack.track);
          return [Object.freeze({ ...publication, track: receivedTrack.track, transceiver: receivedTrack.transceiver })];
        });
        try {
          await waitFor(() => negotiated.every(({ track }) => track.readyState === "live" && !track.muted), REMOTE_TRACK_UNMUTE_TIMEOUT_MS, "Timed out waiting for negotiated remote media to become unmuted");
        } catch (error) {
          this.#requireGeneration(generation);
          this.#publishSnapshot("failed", { code: "media_failed", recoverable: true });
          throw error;
        }
        this.#requireGeneration(generation);
        return negotiated;
      } catch (error) {
        for (const { track, transceiver } of received.values()) {
          safeStopTransceiver(transceiver, this.#reportError.bind(this));
          safeStopTrack(track, this.#reportError.bind(this));
        }
        throw error;
      } finally {
        connection.removeEventListener("track", onTrack);
      }
    }, generation);
  }

  async #completeRenegotiation(response: CloudflareSFUTracksResponse, connection: RTCPeerConnection, connectionId: string, generation: number): Promise<void> {
    if (!response.requiresImmediateRenegotiation && !response.sessionDescription) return;
    if (!response.sessionDescription) throw new CloudflareSFUError("Cloudflare did not return a remote-track offer", "signaling_failed");
    await connection.setRemoteDescription(response.sessionDescription);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await this.#requireTransport().renegotiate({ connectionId, sessionDescription: requireDescription(answer) });
    this.#requireGeneration(generation);
  }

  #serializeSDP<T>(operation: () => Promise<T>, generation: number): Promise<T> {
    if (generation !== this.#generation || this.#stopped) return operation();
    const tail = this.#sdpTailGeneration === generation ? this.#sdpTail : Promise.resolve();
    const result = tail.then(operation, operation);
    this.#sdpTailGeneration = generation;
    this.#sdpTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #waitForConnection(connection: RTCPeerConnection, generation: number): Promise<void> {
    return waitFor(
      () => {
        this.#requireGeneration(generation);
        return connectionIsLive(connection);
      },
      CONNECTION_TIMEOUT_MS,
      "Timed out waiting for the Cloudflare SFU peer connection",
    );
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
    if (state.publicationTrack) safeStopTrack(state.publicationTrack, this.#reportError.bind(this));
    safeStopTrack(state.track, this.#reportError.bind(this));
    state.enabled = false;
    state.desiredEnabled = false;
    state.publicationTrack = null;
    state.transceiver = null;
    state.providerPublicationId = null;
    state.pendingOperationId = null;
    state.pendingOperationToken = null;
    state.pendingTrackName = null;
    state.endedListener = null;
  }

  #clearRemoteTracks(): void {
    for (const publication of this.#remoteTracks.values()) safeStopRemoteTrack(publication, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    this.#publishSnapshot();
    this.#emitRemote();
  }

  #schedulePoll(delayMs = this.#nextPollDelay()): void {
    if (this.#stopped || !this.#started || this.#pollTimer !== undefined) return;
    this.#pollTimer = globalThis.setTimeout(async () => {
      this.#pollTimer = undefined;
      try {
        await this.refreshRemotePublications();
      } catch {
        // Remote discovery reports its own operation-scoped error and retries on the next poll.
      } finally {
        this.#schedulePoll();
      }
    }, delayMs);
  }

  #clearPoll(): void {
    if (this.#pollTimer !== undefined) globalThis.clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  #nextPollDelay(): number {
    if (this.#failedRemotePullAttempts === 0) return this.#pollIntervalMs;
    const baseDelay = Math.max(1, this.#pollIntervalMs);
    return baseDelay * 2 ** Math.min(this.#failedRemotePullAttempts, MAX_REMOTE_POLL_BACKOFF_EXPONENT);
  }

  #recordRemotePullFailure(cursor: PublicationCursor): void {
    if (!samePublicationCursor(this.#failedRemoteCursor, cursor)) {
      this.#failedRemoteCursor = cursor;
      this.#failedRemotePullAttempts = 0;
    }
    this.#failedRemotePullAttempts = Math.min(this.#failedRemotePullAttempts + 1, MAX_REMOTE_POLL_BACKOFF_EXPONENT);
  }

  #clearRemotePollBackoff(): void {
    this.#failedRemoteCursor = null;
    this.#failedRemotePullAttempts = 0;
  }

  #projectLocalPublications(): readonly MediaPublication[] {
    return [...this.#localTracks.values()].map((state) => ({
      participantId: this.#participantId,
      source: state.source,
      enabled: state.enabled,
      publicationId: state.enabled ? state.providerPublicationId : null,
    }));
  }

  #projectRemotePublications(): readonly MediaPublication[] {
    return [...this.#remoteTracks.values()].map(({ participantId, source, publicationId }) => ({ participantId, source, publicationId, enabled: true }));
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
  if (!options.participantId.trim()) throw new CloudflareSFUError("Cloudflare SFU participant is missing", "invalid_bootstrap");
  if (options.pollIntervalMs !== undefined && (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0)) {
    throw new CloudflareSFUError("Cloudflare SFU polling interval is invalid", "invalid_bootstrap");
  }
}

function validateBootstrap(bootstrap: CloudflareSFUBootstrap): void {
  if (!bootstrap.connectionId.trim() || !bootstrap.stunServer.trim()) throw new CloudflareSFUError("Cloudflare SFU bootstrap is incomplete", "invalid_bootstrap");
}

function validateTrackSource(source: MediaSource, track: MediaStreamTrack): void {
  const valid = source === "microphone" ? track.kind === "audio" : track.kind === "video";
  if (!valid) throw new CloudflareSFUError(`The prepared ${source} track has an incompatible kind`, "media_failed");
}

function validateRemoteTrackSource(source: MediaSource, track: MediaStreamTrack): void {
  const valid = source === "microphone" ? track.kind === "audio" : track.kind === "video";
  if (!valid) throw new CloudflareSFUError(`The negotiated ${source} track has an incompatible kind`, "media_failed");
}

function requireRemoteTrackResponses(requested: readonly { readonly sessionId: string; readonly trackName: string }[], responseTracks: readonly CloudflareSFUTrackRequest[]): Map<string, CloudflareSFUTrackRequest> {
  const requestedIdentities = new Set(requested.map((track) => remoteTrackIdentity(track.sessionId, track.trackName)));
  if (requestedIdentities.size !== requested.length || responseTracks.length > requested.length) {
    throw new CloudflareSFUError("Cloudflare SFU returned an incomplete remote-track response", "media_failed");
  }

  const responseTracksByIdentity = new Map<string, CloudflareSFUTrackRequest>();
  for (const responseTrack of responseTracks) {
    if (
      !responseTrack ||
      typeof responseTrack !== "object" ||
      responseTrack.location !== "remote" ||
      typeof responseTrack.sessionId !== "string" ||
      !responseTrack.sessionId.trim() ||
      typeof responseTrack.trackName !== "string" ||
      !responseTrack.trackName.trim() ||
      typeof responseTrack.mid !== "string" ||
      !responseTrack.mid.trim()
    ) {
      throw new CloudflareSFUError("Cloudflare SFU returned an invalid remote-track response", "media_failed");
    }
    const identity = remoteTrackIdentity(responseTrack.sessionId, responseTrack.trackName);
    if (!requestedIdentities.has(identity) || responseTracksByIdentity.has(identity)) {
      throw new CloudflareSFUError("Cloudflare SFU returned an unexpected remote track", "media_failed");
    }
    responseTracksByIdentity.set(identity, responseTrack);
  }
  return responseTracksByIdentity;
}

function remoteTrackIdentity(sessionId: string, trackName: string): string {
  return JSON.stringify([sessionId, trackName]);
}

function samePublicationCursor(left: PublicationCursor | null, right: PublicationCursor): boolean {
  return left !== null && left.incarnation === right.incarnation && left.sequence === right.sequence && left.signature === right.signature;
}

function desiredRemotePublications(publications: readonly CloudflareSFUPublication[], participantId: string): Map<string, CloudflareSFUPublication> {
  return new Map(publications.filter((publication) => publication.participantId !== participantId).map((publication) => [publicationKey(publication), publication]));
}

function reconcileRemoteTracks(desired: ReadonlyMap<string, CloudflareSFUPublication>, pulled: readonly InternalRemoteTrack[], current: ReadonlyMap<string, InternalRemoteTrack>, allowMissing: boolean): Map<string, InternalRemoteTrack> {
  const pulledByKey = new Map(pulled.map((publication) => [publicationKey(publication), publication]));
  const next = new Map<string, InternalRemoteTrack>();
  for (const [key, publication] of desired) {
    const pulledTrack = pulledByKey.get(key);
    const currentTrack = current.get(key);
    const track = pulledTrack ?? (currentTrack?.publicationId === publication.publicationId ? currentTrack : undefined);
    if (!track) {
      if (allowMissing) continue;
      throw new CloudflareSFUError("Cloudflare SFU did not return a requested remote track", "media_failed");
    }
    if (track.publicationId !== publication.publicationId) {
      if (allowMissing) continue;
      throw new CloudflareSFUError("Cloudflare SFU did not return a requested remote track", "media_failed");
    }
    next.set(key, track);
  }
  return next;
}

function stopReplacedRemoteTracks(current: ReadonlyMap<string, InternalRemoteTrack>, next: ReadonlyMap<string, InternalRemoteTrack>, onError: (error: unknown) => void): void {
  for (const [key, previous] of current) {
    if (next.get(key) !== previous) safeStopRemoteTrack(previous, onError);
  }
}

function observeConnectionState(peerState: RTCPeerConnectionState, iceState: RTCIceConnectionState, started: boolean): (Pick<CloudflareSFUSnapshot, "failure"> & { readonly phase: CloudflareSFUSnapshot["connection"]["phase"] }) | null {
  if (peerState === "failed") return { phase: "failed", failure: { code: "peer_connection_failed", recoverable: true } };
  if (iceState === "failed") return { phase: "failed", failure: { code: "ice_connection_failed", recoverable: true } };
  if (peerState === "disconnected" || iceState === "disconnected") return { phase: "recovering", failure: null };
  if (started && peerState === "connected" && (iceState === "connected" || iceState === "completed")) return { phase: "live", failure: null };
  return null;
}

function connectionIsLive(connection: RTCPeerConnection): boolean {
  return connection.connectionState === "connected" && (connection.iceConnectionState === "connected" || connection.iceConnectionState === "completed");
}

function requireTransceiverMid(transceiver: RTCRtpTransceiver): string {
  if (transceiver.mid === null) throw new CloudflareSFUError("Browser did not assign a media section", "media_failed");
  return transceiver.mid;
}

function localTrackRequests(publications: readonly PendingLocalPublication[]): readonly CloudflareSFUTrackRequest[] {
  return publications.map(({ state, transceiver, trackName }) => ({
    location: "local",
    mid: requireTransceiverMid(transceiver),
    trackName,
    source: state.source,
  }));
}

function safeStopTrack(track: MediaStreamTrack, onError: (error: unknown) => void): void {
  try {
    track.stop();
  } catch (error) {
    onError(error);
  }
}

function safeStopTransceiver(transceiver: RTCRtpTransceiver, onError: (error: unknown) => void): void {
  try {
    transceiver.stop();
  } catch (error) {
    onError(error);
  }
}

function safeStopRemoteTrack(track: InternalRemoteTrack, onError: (error: unknown) => void): void {
  safeStopTransceiver(track.transceiver, onError);
  safeStopTrack(track.track, onError);
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
  return right !== undefined && left.participantId === right.participantId && left.source === right.source && left.publicationId === right.publicationId && left.track === right.track;
}
