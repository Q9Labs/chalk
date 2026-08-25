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
import type { RtcConnectionStateSnapshot, RtcStatsLike } from "../telemetry/rtc";

type LocalTrackState = {
  readonly source: MediaSource;
  readonly track: MediaStreamTrack;
  transceiver: RTCRtpTransceiver | null;
  providerPublicationId: string | null;
  pendingOperationId: string | null;
  pendingTrackName: string | null;
  desiredEnabled: boolean;
  enabled: boolean;
  endedListener: (() => void) | null;
};

type PendingLocalPublication = {
  readonly state: LocalTrackState;
  readonly transceiver: RTCRtpTransceiver;
  readonly trackName: string;
  readonly reusedTransceiver: boolean;
};

const EMPTY_LOCAL: readonly CloudflareSFULocalTrack[] = Object.freeze([]);
const EMPTY_REMOTE: readonly CloudflareSFURemoteTrack[] = Object.freeze([]);
const INVALID_PUBLICATION_SIGNATURE = "\u0000invalid";
const CONNECTION_TIMEOUT_MS = 8_000;

export class CloudflareSFUClient implements ClientMediaPlane {
  readonly #localListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onRemoteTrack: ((publication: CloudflareSFURemoteTrack) => void) | undefined;
  readonly #onRtcSummary: CloudflareSFUClientOptions["onRtcSummary"];
  readonly #onScreenEnded: (() => void) | undefined;
  readonly #participantId: string;
  readonly #peerConnectionFactory: ((configuration: RTCConfiguration) => RTCPeerConnection) | undefined;
  readonly #pollIntervalMs: number;
  readonly #replaceMediaConnection: (() => Promise<CloudflareSFUBootstrap>) | undefined;
  readonly #remoteListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #snapshotListeners = new Set<() => void>();
  readonly #localTracks = new Map<MediaSource, LocalTrackState>();
  readonly #reusableLocalTransceivers = new Map<MediaSource, RTCRtpTransceiver>();
  readonly #remoteTracks = new Map<string, CloudflareSFURemoteTrack>();
  #bootstrap: CloudflareSFUBootstrap;
  #connection: RTCPeerConnection;
  #connectionEpoch = 0;
  #cursor: PublicationCursor | null = null;
  #generation = 0;
  #negotiatedGeneration: number | null = null;
  #replacementAttemptedGeneration: number | null = null;
  #polling = false;
  #pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #sdpTail: Promise<void> = Promise.resolve();
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
    this.#replaceMediaConnection = options.replaceMediaConnection;
    this.#onError = options.onError;
    this.#onRemoteTrack = options.onRemoteTrack;
    this.#onRtcSummary = options.onRtcSummary;
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
    this.#observeConnection(this.#connection, this.#generation, this.#connectionEpoch);
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
      transceiver: this.#reusableLocalTransceivers.get(source) ?? null,
      providerPublicationId: null,
      pendingOperationId: null,
      pendingTrackName: null,
      desiredEnabled: false,
      enabled: false,
      endedListener: null,
    };
    this.#reusableLocalTransceivers.delete(source);
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
    if (state.transceiver) this.#reusableLocalTransceivers.set(source, state.transceiver);
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
      if (!this.#stopped) this.#reportError(error);
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
    const connectionEpoch = ++this.#connectionEpoch;
    this.#polling = false;
    this.#clearPoll();
    this.#disposeConnection(false);
    this.#reusableLocalTransceivers.clear();
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#negotiatedGeneration = null;
    this.#replacementAttemptedGeneration = null;
    this.#bootstrap = options.bootstrap;
    if (options.transport) this.#transport = options.transport;
    this.#connection = this.#createPeerConnection(options.bootstrap);
    this.#observeConnection(this.#connection, generation, connectionEpoch);
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
    this.#connectionEpoch++;
    this.#clearPoll();
    this.#polling = false;
    this.#disposeConnection(true);
    this.#reusableLocalTransceivers.clear();
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

  async #enablePreparedTrack(state: LocalTrackState, operationId?: string): Promise<void> {
    if (operationId && state.pendingOperationId !== operationId) {
      state.pendingOperationId = operationId;
      state.pendingTrackName = `${state.source}-${operationId}`;
    }
    state.desiredEnabled = true;
    state.track.enabled = true;
    try {
      await this.#publishPreparedTracks([state], this.#generation);
    } catch (error) {
      state.desiredEnabled = false;
      state.enabled = false;
      state.track.enabled = false;
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
    state.enabled = false;
    state.providerPublicationId = null;
    state.pendingOperationId = null;
    state.pendingTrackName = null;
    this.#publishSnapshot();
    this.#emitLocal();
  }

  async #publishPreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    if (states.length === 0) return;
    await this.#serializeSDP(async () => {
      await this.#replaceDormantConnectionBeforeNegotiation(generation);
      try {
        await this.#publishPreparedTracksSerialized(states, generation, this.#connection, this.#bootstrap.connectionId);
      } catch (error) {
        if (!this.#replaceMediaConnection || !this.#isRetryableConnectionFailure(error) || this.#replacementAttemptedGeneration === generation) throw error;
        await this.#replaceMediaConnectionForRecovery(generation);
        await this.#publishPreparedTracksSerialized(
          [...this.#localTracks.values()].filter((state) => (state.desiredEnabled || states.includes(state)) && state.track.readyState !== "ended"),
          generation,
          this.#connection,
          this.#bootstrap.connectionId,
        );
      }
    });
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
      this.#negotiatedGeneration = generation;
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
    const reusedTransceiver = state.transceiver !== null;
    const transceiver = state.transceiver ?? connection.addTransceiver(state.track, { direction: "sendonly" });
    if (reusedTransceiver) await transceiver.sender.replaceTrack(state.track);
    state.transceiver = transceiver;
    return { state, transceiver, trackName: state.pendingTrackName ?? `${state.source}-${globalThis.crypto.randomUUID()}`, reusedTransceiver };
  }

  async #negotiateLocalPublications(connection: RTCPeerConnection, connectionId: string, publications: readonly PendingLocalPublication[], generation: number): Promise<CloudflareSFUTracksResponse> {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const tracks = publications.map(
      ({ state, transceiver, trackName }): CloudflareSFUTrackRequest => ({
        location: "local",
        mid: requireTransceiverMid(transceiver),
        trackName,
        source: state.source,
      }),
    );
    const response = await this.#requireTransport().addTracks({ connectionId, sessionDescription: requireDescription(offer), tracks });
    this.#requireGeneration(generation);
    await connection.setRemoteDescription(requireSFUDescription(response.sessionDescription));
    return response;
  }

  #confirmLocalPublications(publications: readonly PendingLocalPublication[], tracks: readonly CloudflareSFUTrackRequest[] | undefined): void {
    for (const { state, transceiver } of publications) {
      const authoritative = tracks?.find((track) => track.location === "local" && track.mid === transceiver.mid && track.source === state.source);
      if (!authoritative?.publicationId) throw new CloudflareSFUError("Chalk did not return an authoritative local publication ID", "invalid_publication");
      state.desiredEnabled = true;
      state.enabled = true;
      state.providerPublicationId = authoritative.publicationId;
      state.pendingOperationId = null;
      state.pendingTrackName = null;
    }
  }

  async #discardLocalPublications(publications: readonly PendingLocalPublication[]): Promise<void> {
    for (const { state, transceiver, reusedTransceiver } of publications) {
      if (reusedTransceiver) {
        try {
          await transceiver.sender.replaceTrack(null);
        } catch (error) {
          this.#reportError(error);
        }
        continue;
      }
      try {
        transceiver.stop();
      } catch (error) {
        this.#reportError(error);
      }
      if (state.transceiver === transceiver) state.transceiver = null;
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
    const cursor = this.#validatedRemotePublicationCursor(authoritative);
    if (cursor === null) return;
    const ordering = comparePublicationCursor(this.#cursor, cursor);
    if (ordering !== "newer") return;

    const desired = this.#desiredRemotePublications(authoritative, cursor);
    const toPull = [...desired].filter(([key, publication]) => this.#remoteTracks.get(key)?.publicationId !== publication.publicationId).map(([, publication]) => publication);
    const pulled = await this.#pullWithRecovery(toPull, cursor, generation);
    if (pulled === null) return;
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

  #validatedRemotePublicationCursor(authoritative: CloudflareSFUPublicationSnapshot): PublicationCursor | null {
    if (this.#cursor?.signature === INVALID_PUBLICATION_SIGNATURE && this.#cursor.incarnation === authoritative.incarnation && this.#cursor.sequence === authoritative.sequence) return null;
    try {
      return validatePublicationSnapshot(authoritative);
    } catch (error) {
      this.#quarantineInvalidRemotePublicationCursor(authoritative);
      throw error;
    }
  }

  #desiredRemotePublications(authoritative: CloudflareSFUPublicationSnapshot, cursor: PublicationCursor): ReturnType<typeof desiredRemotePublications> {
    try {
      return desiredRemotePublications(authoritative.publications, this.#participantId);
    } catch (error) {
      this.#observeRemotePublicationCursor(cursor);
      throw error;
    }
  }

  async #pullWithRecovery(publications: readonly CloudflareSFUPublication[], cursor: PublicationCursor, generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    try {
      return await this.#pull(publications, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      if (!this.#canReplaceConnectionAfterRemotePull(error, generation)) {
        this.#observeRemotePublicationCursor(cursor);
        throw error;
      }
      return this.#retryRemotePullOnReplacement(publications, cursor, generation);
    }
  }

  #canReplaceConnectionAfterRemotePull(error: unknown, generation: number): boolean {
    return error instanceof CloudflareSFUError && error.code === "signaling_failed" && this.#remoteTracks.size === 0 && this.#replaceMediaConnection !== undefined && this.#replacementAttemptedGeneration !== generation;
  }

  async #retryRemotePullOnReplacement(publications: readonly CloudflareSFUPublication[], cursor: PublicationCursor, generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    try {
      await this.#replaceMediaConnectionForRecovery(generation);
      await this.#republishPreparedTracksAfterRecovery(generation);
      return await this.#pull(publications, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      this.#observeRemotePublicationCursor(cursor);
      throw error;
    }
  }

  async #pull(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    if (publications.length === 0) return [];
    return this.#serializeSDP(async () => {
      const connection = this.#connection;
      const connectionId = this.#bootstrap.connectionId;
      const requested = publications.map((publication) => {
        const reference = parseCloudflareSFUPublicationID(publication.publicationId);
        return { location: "remote" as const, sessionId: reference.connectionId, trackName: reference.trackName };
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
        await this.#waitForConnection(connection, generation);
        this.#negotiatedGeneration = generation;
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

  #observeConnection(connection: RTCPeerConnection, generation: number, connectionEpoch: number): void {
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      connection.removeEventListener("connectionstatechange", capture);
      connection.removeEventListener("iceconnectionstatechange", capture);
      connection.removeEventListener("signalingstatechange", capture);
    };
    const observe = () => {
      if (disposed || generation !== this.#generation || connectionEpoch !== this.#connectionEpoch || this.#stopped) return;
      const observation = observeConnectionState(connection.connectionState, connection.iceConnectionState, this.#started);
      if (observation) this.#publishSnapshot(observation.phase, observation.failure);
      else this.#publishSnapshot();
    };
    const capture = () => {
      if (disposed || generation !== this.#generation || connectionEpoch !== this.#connectionEpoch || this.#stopped) return;
      observe();
      const recorder = this.#onRtcSummary;
      if (recorder) {
        let stats: Promise<RTCStatsReport>;
        try {
          stats = Promise.resolve(connection.getStats());
        } catch {
          stats = Promise.reject(new Error("RTC stats are unavailable"));
        }
        void stats
          .then((report) => {
            if (disposed || generation !== this.#generation || connectionEpoch !== this.#connectionEpoch || this.#stopped) return;
            recorder(rtcConnectionState(connection), rtcStats(report));
          })
          .catch(() => undefined);
      }
      if (connection.connectionState === "closed") dispose();
    };
    connection.addEventListener("connectionstatechange", capture);
    connection.addEventListener("iceconnectionstatechange", capture);
    connection.addEventListener("signalingstatechange", capture);
    capture();
  }

  async #replaceDormantConnectionBeforeNegotiation(generation: number): Promise<void> {
    if (!this.#started || this.#negotiatedGeneration === generation || this.#replacementAttemptedGeneration === generation || !this.#replaceMediaConnection) return;
    await this.#replaceMediaConnectionForRecovery(generation);
  }

  async #replaceMediaConnectionForRecovery(generation: number): Promise<void> {
    this.#requireGeneration(generation);
    if (!this.#replaceMediaConnection || this.#replacementAttemptedGeneration === generation) {
      throw new CloudflareSFUError("A fresh Cloudflare SFU connection is unavailable", "signaling_failed");
    }
    this.#replacementAttemptedGeneration = generation;
    const bootstrap = await this.#replaceMediaConnection();
    this.#requireGeneration(generation);
    validateBootstrap(bootstrap);
    if (bootstrap.connectionId === this.#bootstrap.connectionId) {
      throw new CloudflareSFUError("Participant access did not replace the Cloudflare SFU connection", "signaling_failed");
    }
    const connectionEpoch = ++this.#connectionEpoch;
    this.#disposeConnection(false);
    this.#reusableLocalTransceivers.clear();
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#bootstrap = bootstrap;
    this.#connection = this.#createPeerConnection(bootstrap);
    this.#negotiatedGeneration = null;
    this.#observeConnection(this.#connection, generation, connectionEpoch);
    for (const state of this.#localTracks.values()) {
      state.transceiver = null;
      state.enabled = false;
      state.providerPublicationId = null;
    }
    this.#setPhase("recovering", null);
  }

  async #republishPreparedTracksAfterRecovery(generation: number): Promise<void> {
    const enabled = [...this.#localTracks.values()].filter((state) => state.desiredEnabled && state.track.readyState !== "ended");
    await this.#publishPreparedTracks(enabled, generation);
  }

  #observeRemotePublicationCursor(cursor: PublicationCursor): void {
    this.#cursor = cursor;
    this.#publishSnapshot();
  }

  #quarantineInvalidRemotePublicationCursor(authoritative: CloudflareSFUPublicationSnapshot): void {
    if (!Number.isSafeInteger(authoritative.incarnation) || authoritative.incarnation < 0 || !Number.isSafeInteger(authoritative.sequence) || authoritative.sequence < 0) return;
    this.#observeRemotePublicationCursor({ incarnation: authoritative.incarnation, sequence: authoritative.sequence, signature: INVALID_PUBLICATION_SIGNATURE });
  }

  #isRetryableConnectionFailure(error: unknown): boolean {
    return error instanceof CloudflareSFUError && error.code === "signaling_failed" && error.options.retryableConnection === true;
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
    state.providerPublicationId = null;
    state.pendingOperationId = null;
    state.pendingTrackName = null;
    state.endedListener = null;
  }

  #clearRemoteTracks(): void {
    for (const publication of this.#remoteTracks.values()) safeStopTrack(publication.track, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    this.#publishSnapshot();
    this.#emitRemote();
  }

  #schedulePoll(delayMs = this.#pollIntervalMs): void {
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

function rtcConnectionState(connection: RTCPeerConnection): RtcConnectionStateSnapshot {
  return {
    connectionState: connection.connectionState,
    iceConnectionState: connection.iceConnectionState,
    signalingState: connection.signalingState,
  };
}

function rtcStats(report: RTCStatsReport): readonly RtcStatsLike[] {
  const entries: RtcStatsLike[] = [];
  report.forEach((entry) => {
    if (typeof entry.type !== "string") return;
    entries.push({ type: entry.type, ...rtcTrafficStats(entry), ...rtcQualityStats(entry), ...rtcTransportStats(entry) });
  });
  return entries;
}

function rtcTrafficStats(entry: object): RtcStatsLike {
  const bytesReceived = rtcNumber(entry, "bytesReceived");
  const bytesSent = rtcNumber(entry, "bytesSent");
  const packetsReceived = rtcNumber(entry, "packetsReceived");
  const packetsSent = rtcNumber(entry, "packetsSent");
  return {
    ...(bytesReceived !== undefined ? { bytesReceived } : {}),
    ...(bytesSent !== undefined ? { bytesSent } : {}),
    ...(packetsReceived !== undefined ? { packetsReceived } : {}),
    ...(packetsSent !== undefined ? { packetsSent } : {}),
  };
}

function rtcQualityStats(entry: object): RtcStatsLike {
  const kind = rtcString(entry, "kind");
  const framesDropped = rtcNumber(entry, "framesDropped");
  const jitter = rtcNumber(entry, "jitter");
  const packetsLost = rtcNumber(entry, "packetsLost");
  const roundTripTime = rtcNumber(entry, "roundTripTime");
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(framesDropped !== undefined ? { framesDropped } : {}),
    ...(jitter !== undefined ? { jitter } : {}),
    ...(packetsLost !== undefined ? { packetsLost } : {}),
    ...(roundTripTime !== undefined ? { roundTripTime } : {}),
  };
}

function rtcTransportStats(entry: object): RtcStatsLike {
  const state = rtcString(entry, "state");
  const selected = rtcBoolean(entry, "selected");
  const nominated = rtcBoolean(entry, "nominated");
  const dtlsState = rtcString(entry, "dtlsState");
  return {
    ...(state !== undefined ? { state } : {}),
    ...(selected !== undefined ? { selected } : {}),
    ...(nominated !== undefined ? { nominated } : {}),
    ...(dtlsState !== undefined ? { dtlsState } : {}),
  };
}

function rtcString(value: object, property: string): string | undefined {
  const candidate: unknown = Reflect.get(value, property);
  return typeof candidate === "string" ? candidate : undefined;
}

function rtcNumber(value: object, property: string): number | undefined {
  const candidate: unknown = Reflect.get(value, property);
  return typeof candidate === "number" ? candidate : undefined;
}

function rtcBoolean(value: object, property: string): boolean | undefined {
  const candidate: unknown = Reflect.get(value, property);
  return typeof candidate === "boolean" ? candidate : undefined;
}

function validateBootstrap(bootstrap: CloudflareSFUBootstrap): void {
  if (!bootstrap.connectionId.trim() || !bootstrap.stunServer.trim()) throw new CloudflareSFUError("Cloudflare SFU bootstrap is incomplete", "invalid_bootstrap");
}

function validateTrackSource(source: MediaSource, track: MediaStreamTrack): void {
  const valid = source === "microphone" ? track.kind === "audio" : track.kind === "video";
  if (!valid) throw new CloudflareSFUError(`The prepared ${source} track has an incompatible kind`, "media_failed");
}

function desiredRemotePublications(publications: readonly CloudflareSFUPublication[], participantId: string): Map<string, CloudflareSFUPublication> {
  return new Map(publications.filter((publication) => publication.participantId !== participantId).map((publication) => [publicationKey(publication), publication]));
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

function connectionIsLive(connection: RTCPeerConnection): boolean {
  return connection.connectionState === "connected" && (connection.iceConnectionState === "connected" || connection.iceConnectionState === "completed");
}

function requireTransceiverMid(transceiver: RTCRtpTransceiver): string {
  if (transceiver.mid === null) throw new CloudflareSFUError("Browser did not assign a media section", "media_failed");
  return transceiver.mid;
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
  return right !== undefined && left.participantId === right.participantId && left.source === right.source && left.publicationId === right.publicationId && left.track === right.track;
}
