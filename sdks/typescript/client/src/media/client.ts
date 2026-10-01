import type { ClientMediaPlane, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaSource } from "./plane";
import { CameraUplinkPolicy, cameraUplinkBitrate } from "./camera-uplink";
import { subscribeSnapshot } from "./observers";
import { resolveMediaTarget } from "./target";
import { comparePublicationCursor, parseCloudflareSFUPublicationID, publicationKey, requireDescription, requireSFUDescription, validatePublicationSnapshot, waitFor } from "./tracks";
import { matchRemotePullTracks } from "./remote-track-response";
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
  transceiver: RTCRtpTransceiver;
  readonly trackName: string;
  readonly reusedTransceiver: boolean;
};

const EMPTY_LOCAL: readonly CloudflareSFULocalTrack[] = Object.freeze([]);
const EMPTY_REMOTE: readonly CloudflareSFURemoteTrack[] = Object.freeze([]);
const INVALID_PUBLICATION_SIGNATURE = "\u0000invalid";
const CONNECTION_TIMEOUT_MS = 8_000;
const NEGOTIATION_TIMEOUT_MS = 35_000;
const PEER_OPERATION_TIMEOUT_MS = 8_000;

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
  readonly #locallyPausedSources = new Set<MediaSource>();
  readonly #localTracks = new Map<MediaSource, LocalTrackState>();
  readonly #reusableLocalTransceivers = new Map<MediaSource, RTCRtpTransceiver>();
  readonly #reusableLocalPublicationIds = new Map<MediaSource, string>();
  readonly #remoteTracks = new Map<string, CloudflareSFURemoteTrack>();
  #bootstrap: CloudflareSFUBootstrap;
  #connection: RTCPeerConnection;
  #disposeConnectionObservation: (() => void) | undefined;
  #connectionEpoch = 0;
  #retiredLocalConnection: RTCPeerConnection | null = null;
  #cursor: PublicationCursor | null = null;
  #remotePullIncomplete = false;
  readonly #remotePullRetryAfter = new Map<string, number>();
  #generation = 0;
  #negotiatedGeneration: number | null = null;
  #replacementAttemptedGeneration: number | null = null;
  #polling = false;
  #pollAfterCurrent = false;
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
    this.#pollIntervalMs = options.pollIntervalMs ?? 15_000;
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

  remotePublicationResumed(publicationId: string): void {
    this.#remotePullRetryAfter.delete(publicationId);
    this.remotePublicationsChanged();
  }

  remotePublicationsChanged(): void {
    if (this.#polling) {
      this.#pollAfterCurrent = true;
      return;
    }
    this.#clearPoll();
    this.#schedulePoll(0);
  }

  prepareLocalTrack(source: MediaSource, track: MediaStreamTrack): void {
    this.#requireActive();
    validateTrackSource(source, track);
    if (this.#localTracks.has(source)) throw new CloudflareSFUError(`A ${source} track is already prepared`, "media_failed");
    const state: LocalTrackState = {
      source,
      track,
      transceiver: this.#reusableLocalTransceivers.get(source) ?? null,
      providerPublicationId: this.#reusableLocalPublicationIds.get(source) ?? null,
      pendingOperationId: null,
      pendingTrackName: null,
      desiredEnabled: false,
      enabled: false,
      endedListener: null,
    };
    this.#reusableLocalTransceivers.delete(source);
    this.#reusableLocalPublicationIds.delete(source);
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
    if (state.providerPublicationId) this.#reusableLocalPublicationIds.set(source, state.providerPublicationId);
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
      if (generation === this.#generation) {
        this.#polling = false;
        if (this.#pollAfterCurrent) {
          this.#pollAfterCurrent = false;
          this.#clearPoll();
          this.#schedulePoll(0);
        }
      }
    }
  }

  async setLocalPublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind === "result") return resolved.result;
    const state = resolved.value;
    if (this.#pausedTarget(target)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    try {
      if (target.enabled) await this.#retireUnavailableLocalPublication(state);
      if (this.#pausedTarget(target)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
      if (state.enabled === target.enabled) return { outcome: "satisfied", errorCode: null };
      await this.#setPreparedTrackEnabled(state, target.enabled, target.operationId);
      return { outcome: "confirmed", errorCode: null };
    } catch (error) {
      if (!this.#stopped) this.#reportError(error);
      return mediaTargetFailure(error);
    }
  }

  #pausedTarget(target: MediaPlaneTarget): boolean {
    return target.enabled && this.#locallyPausedSources.has(target.source);
  }

  setLocalSourceIntent(source: MediaSource, enabled: boolean): void {
    if (enabled) {
      this.#locallyPausedSources.delete(source);
      return;
    }
    this.#locallyPausedSources.add(source);
    const state = this.#localTracks.get(source);
    if (!state) return;
    state.desiredEnabled = false;
    state.track.enabled = false;
  }

  async closeForcedLocalPublication(source: MediaSource): Promise<void> {
    this.setLocalSourceIntent(source, false);
    await this.#retireLocalPublication(source);
    if (!this.#replaceMediaConnection) return;
    const generation = this.#generation;
    await this.#serializeSDP(async () => {
      const existing = new Set([...this.#localTracks.values()].filter((state) => state.source !== source && state.providerPublicationId !== null));
      const states = await this.#prepareConnectionForPublication([], generation);
      await this.#publishPreparedTracksSerialized(
        states.filter((state) => existing.has(state)),
        generation,
        this.#connection,
        this.#bootstrap.connectionId,
      );
      this.#requireGeneration(generation);
      this.#setPhase("live", null);
    });
  }

  async #retireUnavailableLocalPublication(state: LocalTrackState): Promise<void> {
    const publicationId = state.providerPublicationId;
    if (!publicationId) return;
    const authoritative = await this.#requireTransport().listPublications();
    if (authoritative.publications.some((publication) => publication.publicationId === publicationId)) return;
    // An authorized on target can precede the old forced-off projection.
    // Never satisfy it from a browser slot whose provider track is gone.
    if (state.providerPublicationId === publicationId) await this.#retireLocalPublication(state.source);
  }

  async #retireLocalPublication(source: MediaSource): Promise<void> {
    const state = this.#localTracks.get(source);
    const transceiver = state?.transceiver ?? this.#reusableLocalTransceivers.get(source);
    const publicationId = state?.providerPublicationId ?? this.#reusableLocalPublicationIds.get(source);
    this.#reusableLocalTransceivers.delete(source);
    this.#reusableLocalPublicationIds.delete(source);
    if (state) {
      state.track.enabled = false;
      state.desiredEnabled = false;
      state.enabled = false;
      state.providerPublicationId = null;
      state.transceiver = null;
    }
    this.#publishSnapshot();
    this.#emitLocal();
    if (!transceiver || !publicationId) return;
    const connection = this.#connection;
    const connectionId = this.#bootstrap.connectionId;
    this.#retiredLocalConnection = connection;
    await this.#serializeSDP(async () => {
      if (connection !== this.#connection) return;
      const mid = requireTransceiverMid(transceiver);
      await this.#boundPeerOperation(transceiver.sender.replaceTrack(null));
      transceiver.stop();
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      try {
        const response = await this.#requireTransport().closeTracks({
          connectionId,
          ...providerDescription(requireDescription(offer)),
          tracks: [{ mid, source, publicationId }],
          force: false,
        });
        await this.#applyProviderDescription(response, connection);
      } catch (error) {
        await this.#rollbackLocalOffer(connection);
        if (!this.#stopped) this.#reportError(error);
        throw error;
      }
    });
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
    this.#pollAfterCurrent = false;
    this.#clearPoll();
    this.#remotePullRetryAfter.clear();
    this.#disposeConnection(false);
    this.#reusableLocalTransceivers.clear();
    this.#reusableLocalPublicationIds.clear();
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
    this.#remotePullRetryAfter.clear();
    this.#polling = false;
    this.#pollAfterCurrent = false;
    this.#disposeConnection(true);
    this.#reusableLocalTransceivers.clear();
    this.#reusableLocalPublicationIds.clear();
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
    if (state.providerPublicationId && state.transceiver) {
      state.desiredEnabled = true;
      state.track.enabled = true;
      try {
        await this.#boundPeerOperation(state.transceiver.sender.replaceTrack(state.track));
      } catch (error) {
        state.desiredEnabled = false;
        state.track.enabled = false;
        throw error;
      }
      state.enabled = !this.#locallyPausedSources.has(state.source);
      state.desiredEnabled = state.enabled;
      state.track.enabled = state.enabled;
      if (!state.enabled) await this.#boundPeerOperation(state.transceiver.sender.replaceTrack(null));
      this.#publishSnapshot();
      this.#emitLocal();
      return;
    }
    if (operationId && state.pendingOperationId !== operationId) {
      state.pendingOperationId = operationId;
      state.pendingTrackName = `${state.source}-${operationId}`;
    }
    state.desiredEnabled = true;
    state.track.enabled = true;
    const generation = this.#generation;
    try {
      await this.#publishPreparedTracks([state], generation);
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
    // Queue the detach before notifying consumers, but never wait to expose off.
    const detach = transceiver ? this.#boundPeerOperation(transceiver.sender.replaceTrack(null)) : Promise.resolve();
    state.enabled = false;
    state.pendingOperationId = null;
    state.pendingTrackName = null;
    this.#publishSnapshot();
    this.#emitLocal();
    await detach;
  }

  async #publishPreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    if (states.length === 0) return;
    await this.#serializeSDP(async () => {
      const pending = await this.#prepareConnectionForPublication(states, generation);
      this.#replacementAttemptedGeneration = null;
      try {
        await this.#publishPreparedTracksSerialized(pending, generation, this.#connection, this.#bootstrap.connectionId);
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

  async #prepareConnectionForPublication(states: readonly LocalTrackState[], generation: number): Promise<readonly LocalTrackState[]> {
    if (this.#retiredLocalConnection !== this.#connection || !this.#replaceMediaConnection) {
      await this.#replaceDormantConnectionBeforeNegotiation(generation);
      return states;
    }
    // Retiring the bundled sender can expire the Cloudflare SFU connection.
    // Rebuild before publishing, retaining only other provider-authorized sources.
    const authoritative = await this.#requireTransport().listPublications();
    this.#pauseUnavailableOtherSources(authoritative.publications, states);
    this.#replacementAttemptedGeneration = null;
    await this.#replaceMediaConnectionForRecovery(generation);
    return [...this.#localTracks.values()].filter((state) => (state.desiredEnabled || states.includes(state)) && state.track.readyState !== "ended");
  }

  #pauseUnavailableOtherSources(publications: readonly CloudflareSFUPublication[], states: readonly LocalTrackState[]): void {
    for (const state of this.#localTracks.values()) {
      if (states.includes(state) || !state.providerPublicationId) continue;
      if (publications.some((publication) => publication.publicationId === state.providerPublicationId)) continue;
      state.desiredEnabled = false;
      state.track.enabled = false;
    }
  }

  async #publishPreparedTracksSerialized(states: readonly LocalTrackState[], generation: number, connection: RTCPeerConnection, connectionId: string): Promise<void> {
    this.#requireGeneration(generation);
    const pendingStates = states.filter((state) => !state.enabled);
    if (pendingStates.length === 0) return;
    const wasLive = connectionIsLive(connection);
    const publications: PendingLocalPublication[] = [];
    try {
      for (const state of pendingStates) publications.push(await this.#prepareLocalPublication(connection, state, generation));
      const response = await this.#negotiateLocalPublications(connection, connectionId, publications, generation);
      if (!wasLive) await this.#waitForConnection(connection, generation);
      this.#requireGeneration(generation);
      this.#negotiatedGeneration = generation;
      this.#confirmLocalPublications(publications, response.tracks);
      this.#publishSnapshot();
      this.#emitLocal();
    } catch (error) {
      if (generation === this.#generation) {
        await this.#rollbackLocalOffer(connection);
        await this.#discardLocalPublications(publications);
      }
      throw error;
    }
  }

  async #prepareLocalPublication(connection: RTCPeerConnection, state: LocalTrackState, generation: number): Promise<PendingLocalPublication> {
    const reusedTransceiver = state.transceiver !== null;
    const transceiver = state.transceiver ?? this.#addLocalTransceiver(connection, state);
    if (reusedTransceiver) await this.#boundPeerOperation(transceiver.sender.replaceTrack(state.track));
    this.#requireGeneration(generation);
    state.transceiver = transceiver;
    return { state, transceiver, trackName: state.pendingTrackName ?? `${state.source}-${globalThis.crypto.randomUUID()}`, reusedTransceiver };
  }

  #addLocalTransceiver(connection: RTCPeerConnection, state: LocalTrackState): RTCRtpTransceiver {
    if (state.source !== "camera" || firefoxCameraSimulcastUnsupported()) return connection.addTransceiver(state.track, { direction: "sendonly" });
    // 720p and 360p have a 4:1 pixel ratio; budget about 4:1 bandwidth.
    // Match a single-stream camera's temporal mode so h does not spend
    // its constrained uplink budget on extra temporal-layer overhead.
    const sendEncodings = [
      { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2_500_000, scalabilityMode: "L1T1" },
      { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650_000, scalabilityMode: "L1T1" },
    ];
    try {
      return connection.addTransceiver(state.track, {
        direction: "sendonly",
        sendEncodings,
      });
    } catch (error) {
      if (!simulcastUnsupported(error)) throw error;
      return connection.addTransceiver(state.track, { direction: "sendonly" });
    }
  }

  async #negotiateLocalPublications(connection: RTCPeerConnection, connectionId: string, publications: readonly PendingLocalPublication[], generation: number): Promise<CloudflareSFUTracksResponse> {
    let offer: Parameters<RTCPeerConnection["setRemoteDescription"]>[0];
    try {
      offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
    } catch (error) {
      const cameras = publications.filter(({ state, transceiver }) => state.source === "camera" && transceiver.sender.getParameters().encodings.length > 1);
      if (!simulcastUnsupported(error) || cameras.length === 0) throw error;
      await this.#rollbackLocalOffer(connection);
      this.#requireGeneration(generation);
      for (const publication of cameras) {
        await this.#boundPeerOperation(publication.transceiver.sender.replaceTrack(null));
        publication.transceiver.stop();
        publication.transceiver = connection.addTransceiver(publication.state.track, { direction: "sendonly" });
        publication.state.transceiver = publication.transceiver;
      }
      offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
    }
    const tracks = publications.map(
      ({ state, transceiver, trackName }): CloudflareSFUTrackRequest => ({
        location: "local",
        mid: requireTransceiverMid(transceiver),
        trackName,
        source: state.source,
      }),
    );
    const response = await this.#requireTransport().addTracks({ connectionId, ...providerDescription(requireDescription(offer)), tracks });
    this.#requireGeneration(generation);
    await this.#applyProviderDescription(response, connection);
    return response;
  }

  #confirmLocalPublications(publications: readonly PendingLocalPublication[], tracks: readonly CloudflareSFUTrackRequest[] | undefined): void {
    for (const { state, transceiver } of publications) {
      const authoritative = tracks?.find((track) => track.location === "local" && track.mid === transceiver.mid && track.source === state.source);
      if (!authoritative?.publicationId) throw new CloudflareSFUError("Chalk did not return an authoritative local publication ID", "invalid_publication");
      if (state.transceiver !== transceiver) continue;
      state.enabled = !this.#locallyPausedSources.has(state.source);
      state.desiredEnabled = state.enabled;
      state.track.enabled = state.enabled;
      if (!state.enabled) void transceiver.sender.replaceTrack(null).catch((error) => this.#reportError(error));
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
    if (ordering === "stale" || (ordering === "same" && !this.#remotePullIncomplete)) return;

    const desired = this.#desiredRemotePublications(authoritative, cursor);
    const toPull = this.#pendingRemotePulls(desired);
    const pulled = await this.#pullWithRecovery(toPull, cursor, generation);
    if (pulled === null) return;
    this.#requireGeneration(generation);
    const next = reconcileRemoteTracks(desired, pulled, this.#remoteTracks);
    stopReplacedRemoteTracks(this.#remoteTracks, next, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    for (const [key, publication] of next) this.#remoteTracks.set(key, publication);
    this.#cursor = cursor;
    this.#remotePullIncomplete = [...desired].some(([key, publication]) => next.get(key)?.publicationId !== publication.publicationId);
    for (const publication of pulled) this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    this.#publishSnapshot();
    this.#emitRemote();
  }

  #pendingRemotePulls(desired: ReadonlyMap<string, CloudflareSFUPublication>): CloudflareSFUPublication[] {
    const desiredIds = new Set([...desired.values()].map((publication) => publication.publicationId));
    for (const publicationId of this.#remotePullRetryAfter.keys()) {
      if (!desiredIds.has(publicationId)) this.#remotePullRetryAfter.delete(publicationId);
    }
    const now = Date.now();
    return [...desired].filter(([key, publication]) => this.#remoteTracks.get(key)?.publicationId !== publication.publicationId && (this.#remotePullRetryAfter.get(publication.publicationId) ?? 0) <= now).map(([, publication]) => publication);
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
        this.#observeRemotePublicationCursor(cursor, retryableRemotePull(error));
        throw error;
      }
      return this.#retryRemotePullOnReplacement(publications, cursor, generation);
    }
  }

  #canReplaceConnectionAfterRemotePull(error: unknown, generation: number): boolean {
    return error instanceof CloudflareSFUError && error.code === "signaling_failed" && !this.#hasLiveRemoteTracks() && this.#replaceMediaConnection !== undefined && this.#replacementAttemptedGeneration !== generation;
  }

  #hasLiveRemoteTracks(): boolean {
    return [...this.#remoteTracks.values()].some((publication) => publication.track.readyState === "live");
  }

  async #retryRemotePullOnReplacement(publications: readonly CloudflareSFUPublication[], cursor: PublicationCursor, generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    try {
      await this.#replaceMediaConnectionForRecovery(generation);
      await this.#republishPreparedTracksAfterRecovery(generation);
      return await this.#pull(publications, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      this.#observeRemotePublicationCursor(cursor, retryableRemotePull(error));
      throw error;
    }
  }

  async #pull(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    if (publications.length === 0) return [];
    return this.#serializeSDP(async () => {
      const connection = this.#connection;
      const connectionId = this.#bootstrap.connectionId;
      const requested = publications.map((publication): CloudflareSFUTrackRequest => {
        const reference = parseCloudflareSFUPublicationID(publication.publicationId);
        return {
          location: "remote",
          sessionId: reference.connectionId,
          trackName: reference.trackName,
          // h sorts before l: prefer full camera quality, but keep video flowing
          // when the publisher pauses h. Do not silently downgrade a live h layer.
          // https://developers.cloudflare.com/realtime/sfu/features/simulcast/#quality-control
          ...(publication.source === "camera" ? { simulcast: { preferredRid: "h", priorityOrdering: "none", ridNotAvailable: "asciibetical" } as const } : {}),
        };
      });
      const received = new Map<string, MediaStreamTrack>();
      const onTrack = (event: RTCTrackEvent) => {
        if (event.transceiver.mid !== null) received.set(event.transceiver.mid, event.track);
      };
      connection.addEventListener("track", onTrack);
      try {
        this.#requireGeneration(generation);
        const response = await this.#requireTransport().addTracks({ connectionId, tracks: requested, allowPartialRemoteTracks: true });
        this.#requireGeneration(generation);
        this.#recordRemotePullErrors(publications, response.trackErrors ?? []);
        const responseTracks = response.tracks ?? [];
        const matched = matchRemotePullTracks(publications, responseTracks);
        for (const { publication } of matched) this.#remotePullRetryAfter.delete(publication.publicationId);
        await this.#completeRenegotiation(response, connection, connectionId, generation);
        if (matched.length === 0) return [];
        await this.#waitForConnection(connection, generation);
        this.#negotiatedGeneration = generation;
        await waitFor(() => responseTracks.every((track) => track.mid !== undefined && received.has(track.mid)), 5_000);
        this.#requireGeneration(generation);
        return matched.map(({ publication, mid }) => {
          const track = received.get(mid);
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

  #recordRemotePullErrors(publications: readonly CloudflareSFUPublication[], failures: NonNullable<CloudflareSFUTracksResponse["trackErrors"]>): void {
    const requested = new Map(
      publications.map((publication) => {
        const reference = parseCloudflareSFUPublicationID(publication.publicationId);
        return [`${reference.connectionId}\u0000${reference.trackName}`, publication] as const;
      }),
    );
    for (const failure of failures) {
      const publication = requested.get(`${failure.connectionId}\u0000${failure.trackName}`);
      if (!publication) throw new CloudflareSFUError("Cloudflare SFU returned an unrequested remote track error", "invalid_publication");
      this.#remotePullRetryAfter.set(publication.publicationId, Date.now() + 750);
      this.#reportError(new CloudflareSFUError(`Cloudflare SFU remote track failed: ${failure.code}`, "media_failed", { providerCode: failure.code }));
    }
  }

  async #completeRenegotiation(response: CloudflareSFUTracksResponse, connection: RTCPeerConnection, connectionId: string, generation: number): Promise<void> {
    if (!response.requiresImmediateRenegotiation) return;
    await this.#applyProviderDescription(response, connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await this.#requireTransport().renegotiate({ connectionId, ...providerDescription(requireDescription(answer)) });
    this.#requireGeneration(generation);
  }

  async #applyProviderDescription(response: CloudflareSFUTracksResponse, connection = this.#connection): Promise<void> {
    await connection.setRemoteDescription(requireSFUDescription(response.sessionDescription));
  }

  #serializeSDP<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.#generation;
    let expired = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new CloudflareSFUError("Cloudflare SFU negotiation timed out. Try again.", "negotiation_timeout");
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        expired = true;
        if (generation === this.#generation && !this.#stopped) this.#expireNegotiation(timeout);
        reject(timeout);
      }, NEGOTIATION_TIMEOUT_MS);
    });
    const run = () => {
      if (expired || generation !== this.#generation) throw timeout;
      return operation();
    };
    const pending = this.#sdpTail.then(run, run);
    const result = Promise.race([pending, deadline])
      .catch((error: unknown) => {
        if (error instanceof CloudflareSFUError && error.code === "signaling_timeout" && generation === this.#generation && !this.#stopped) this.#expireNegotiation(error);
        throw error;
      })
      .finally(() => {
        if (timer !== undefined) globalThis.clearTimeout(timer);
      });
    this.#sdpTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #boundPeerOperation(operation: Promise<void>): Promise<void> {
    const generation = this.#generation;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new CloudflareSFUError("The browser media operation timed out. Try again.", "negotiation_timeout");
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        if (generation === this.#generation && !this.#stopped) this.#expireNegotiation(timeout);
        reject(timeout);
      }, PEER_OPERATION_TIMEOUT_MS);
    });
    try {
      await Promise.race([operation, deadline]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }

  #expireNegotiation(error: CloudflareSFUError): void {
    this.#generation++;
    this.#connectionEpoch++;
    this.#clearPoll();
    this.#polling = false;
    this.#disposeConnection(false);
    this.#setFailure(error, "media_failed");
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

  #cameraSimulcastSender(state: LocalTrackState | undefined): RTCRtpSender | undefined {
    if (!state?.enabled) return undefined;
    const sender = state.transceiver?.sender;
    if (!sender?.track || sender.getParameters().encodings.length < 2) return undefined;
    return sender;
  }

  async #applyCameraUplink(sender: RTCRtpSender, report: RTCStatsReport, policy: CameraUplinkPolicy): Promise<void> {
    const parameters = sender.getParameters();
    const low = parameters.encodings.find((encoding) => encoding.rid === "l");
    if (!low) return;
    const active = policy.sample(cameraUplinkBitrate(report.values()), low.active !== false);
    if (active === (low.active !== false)) return;
    low.active = active;
    // With only h active the browser can adapt source resolution, rather
    // than repeatedly pausing h while paying for l. Both RIDs stay intact.
    parameters.degradationPreference = "maintain-framerate";
    await sender.setParameters(parameters);
  }

  #observeConnection(connection: RTCPeerConnection, generation: number, connectionEpoch: number): void {
    this.#disposeConnectionObservation?.();
    let disposed = false;
    let cameraTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const cameraPolicy = new CameraUplinkPolicy();
    let observedCamera: LocalTrackState | undefined;
    const current = () => !disposed && generation === this.#generation && connectionEpoch === this.#connectionEpoch && !this.#stopped;
    const adaptCamera = async () => {
      if (!current()) return;
      try {
        const state = this.#localTracks.get("camera");
        if (state !== observedCamera) {
          cameraPolicy.reset();
          observedCamera = state;
        }
        const sender = this.#cameraSimulcastSender(state);
        if (!sender) {
          cameraPolicy.reset();
          return;
        }
        const report = await connection.getStats();
        if (!current() || this.#cameraSimulcastSender(state) !== sender || connection.signalingState !== "stable") return;
        await this.#applyCameraUplink(sender, report, cameraPolicy);
      } catch {
        // Stats and optional sender controls must never break publication.
        cameraPolicy.reset();
      } finally {
        if (current()) cameraTimer = globalThis.setTimeout(adaptCamera, 1_000);
      }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (cameraTimer !== undefined) globalThis.clearTimeout(cameraTimer);
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
    this.#disposeConnectionObservation = dispose;
    cameraTimer = globalThis.setTimeout(adaptCamera, 1_000);
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
    this.#reusableLocalPublicationIds.clear();
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#bootstrap = bootstrap;
    this.#connection = this.#createPeerConnection(bootstrap);
    this.#retiredLocalConnection = null;
    this.#negotiatedGeneration = null;
    this.#observeConnection(this.#connection, generation, connectionEpoch);
    for (const state of this.#localTracks.values()) {
      state.transceiver = null;
      state.enabled = false;
      state.providerPublicationId = null;
    }
    this.#setPhase("recovering", null);
    this.remotePublicationsChanged();
  }

  async #republishPreparedTracksAfterRecovery(generation: number): Promise<void> {
    const enabled = [...this.#localTracks.values()].filter((state) => state.desiredEnabled && state.track.readyState !== "ended");
    await this.#publishPreparedTracks(enabled, generation);
  }

  #observeRemotePublicationCursor(cursor: PublicationCursor, pullIncomplete = false): void {
    this.#cursor = cursor;
    this.#remotePullIncomplete = pullIncomplete;
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
    this.#disposeConnectionObservation?.();
    this.#disposeConnectionObservation = undefined;
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
      // Skip the network round-trip while the tab is hidden; the poll
      // reschedules itself and resumes on the next tick after visibility.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.#schedulePoll();
        return;
      }
      try {
        await this.refreshRemotePublications();
      } catch {
        // Remote discovery reports its own operation-scoped error and retries on the next poll.
      } finally {
        this.#schedulePoll(this.#remotePullIncomplete ? 750 : this.#pollIntervalMs);
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
      publicationId: state.providerPublicationId,
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
              publicationId: state.providerPublicationId,
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
    [...desired].flatMap(([key, publication]) => {
      const track = pulledByKey.get(key) ?? current.get(key);
      if (!track || track.publicationId !== publication.publicationId) return [];
      return [[key, track] as const];
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

function providerDescription(description: ReturnType<typeof requireDescription>): { readonly sessionDescription: ReturnType<typeof requireDescription> } {
  return { sessionDescription: description };
}

function retryableRemotePull(error: unknown): boolean {
  return error instanceof CloudflareSFUError && ["signaling_failed", "signaling_timeout", "media_failed", "negotiation_timeout"].includes(error.code);
}

function firefoxCameraSimulcastUnsupported(): boolean {
  // Firefox accepts RID encodings but can pause 720p h on an unthrottled link.
  // Capabilities do not expose that allocation policy. Preserve the single-
  // camera path for Gecko Firefox; FxiOS uses WebKit and is not matched.
  return typeof navigator !== "undefined" && /\bFirefox\/\d+/i.test(navigator.userAgent);
}

function simulcastUnsupported(error: unknown): boolean {
  return error instanceof Error && ["NotSupportedError", "OperationError", "TypeError"].includes(error.name);
}

function mediaTargetFailure(error: unknown): MediaPlaneResult {
  const code = error instanceof CloudflareSFUError ? error.code : "media_failed";
  const ambiguous = code === "signaling_timeout" || code === "negotiation_timeout";
  return { outcome: ambiguous ? "ambiguous" : "retryable_failure", errorCode: code };
}
