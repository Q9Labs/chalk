import type { ClientMediaPlane, LocalPublicationRetirementCause, MediaConnectionReplacementCause, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaPublicationSource } from "./plane";
import { ReceiveStallRecovery } from "./receive-stall";
import { CameraUplinkPolicy, cameraUplinkBitrate } from "./camera-uplink";
import { ViewerLayerSelector, type ViewerLayerChange } from "./viewer-layer";
import { subscribeSnapshot } from "./observers";
import { resolveMediaTarget } from "./target";
import { comparePublicationCursor, parseCloudflareSFUPublicationID, publicationKey, requireDescription, requireSFUDescription, validatePublicationSnapshot, waitFor } from "./tracks";
import { matchRemotePullTracks } from "./remote-track-response";
import { CloudflareSFUError } from "./types";
import { classifyMediaFailure } from "./failure-diagnostics";
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
  readonly source: MediaPublicationSource;
  readonly track: MediaStreamTrack;
  transceiver: RTCRtpTransceiver | null;
  providerPublicationId: string | null;
  desiredEnabled: boolean;
  enabled: boolean;
  endedListener: (() => void) | null;
  clearing: Promise<void> | null;
};
type OwnedLocalPublication = {
  readonly state: LocalTrackState;
  transceiver: RTCRtpTransceiver;
  readonly trackName: string;
  readonly connection: RTCPeerConnection;
  readonly connectionId: string;
  detachedAt: number | null;
  lifecycle: { kind: "pending" } | { kind: "confirmed"; handle: LocalPublicationHandle } | { kind: "retiring"; handle: LocalPublicationHandle | null; detached: boolean; cause: LocalPublicationRetirementCause } | { kind: "retired" };
};
type LocalPublicationHandle = { readonly publicationId: string; readonly mid: string };
const EMPTY_LOCAL: readonly CloudflareSFULocalTrack[] = Object.freeze([]);
const EMPTY_REMOTE: readonly CloudflareSFURemoteTrack[] = Object.freeze([]);
const EMPTY_RECEIVE_STALLS = Object.freeze([]);
const INVALID_PUBLICATION_SIGNATURE = "\u0000invalid";
const CONNECTION_TIMEOUT_MS = 8000;
const NEGOTIATION_TIMEOUT_MS = 35000;
const PEER_OPERATION_TIMEOUT_MS = 8000;
const VIEWER_LAYER_BATCH_SIZE = 16;
// Adaptation uses at most 12 of the participant's 60 call-control writes/minute.
const VIEWER_LAYER_UPDATE_INTERVAL_MS = 5000;
// Cloudflare expires tracks after 30 seconds without RTP. Leave time for the
// resume operation rather than trusting Chalk's registry as provider liveness.
const CAPTURE_REUSE_WINDOW_MS = 20_000;
export class CloudflareSFUClient implements ClientMediaPlane {
  readonly #localListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #onError: CloudflareSFUClientOptions["onError"];
  readonly #onRemoteTrack: ((publication: CloudflareSFURemoteTrack) => void) | undefined;
  readonly #onScreenEnded: (() => void) | undefined;
  readonly #participantId: string;
  readonly #peerConnectionFactory: ((configuration: RTCConfiguration) => RTCPeerConnection) | undefined;
  readonly #pollIntervalMs: number;
  readonly #replaceMediaConnection: (() => Promise<CloudflareSFUBootstrap>) | undefined;
  readonly #remoteListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #snapshotListeners = new Set<() => void>();
  readonly #failureOwners = new WeakMap<Error, { readonly generation: number; readonly connectionId: string }>();
  readonly #locallyPausedSources = new Map<MediaPublicationSource, LocalPublicationRetirementCause>();
  readonly #localTracks = new Map<MediaPublicationSource, LocalTrackState>();
  readonly #ownedPublications = new Set<OwnedLocalPublication>();
  readonly #remoteTracks = new Map<string, CloudflareSFURemoteTrack>();
  #bootstrap: CloudflareSFUBootstrap;
  #connection: RTCPeerConnection;
  #disposeConnectionObservation: (() => void) | undefined;
  #connectionEpoch = 0;
  #retiredLocalConnection: RTCPeerConnection | null = null;
  #retiredLocalCause: LocalPublicationRetirementCause = "forced_pause";
  #replacementCause: MediaConnectionReplacementCause | undefined;
  #cursor: PublicationCursor | null = null;
  #remotePullIncomplete = false;
  readonly #remotePullRetries = new Map<string, { readonly retryAfter: number; readonly failures: number; readonly receiveStalled?: boolean }>();
  readonly #receiveProgress = new ReceiveStallRecovery();
  readonly #viewerLayerPending = new Map<string, ViewerLayerChange>();
  #viewerLayerUpdating = false;
  #viewerLayerUpdateAt = Number.NEGATIVE_INFINITY;
  #remoteParticipantIds: ReadonlySet<string> | null = null;
  #remoteParticipantRevision = 0;
  readonly #subscribedPublicationIds = new Set<string>();
  #generation = 0;
  #negotiatedGeneration: number | null = null;
  #replacementAttemptedGeneration: number | null = null;
  #remoteRecoveryGeneration: number | null = null;
  #polling = false;
  #pollAfterCurrent = false;
  #pollFailures = 0;
  #pollFailedPull = false;
  #pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #sdpTail: Promise<void> = Promise.resolve();
  #retirement: Promise<void> = Promise.resolve();
  #snapshot: CloudflareSFUSnapshot;
  #started = false;
  #receivingInitial = false;
  #stopped = false;
  #transport: CloudflareSFUSignalingTransport | undefined;
  constructor(options: CloudflareSFUClientOptions) {
    validateClientOptions(options);
    this.#participantId = options.participantId;
    this.#bootstrap = options.bootstrap;
    this.#transport = options.transport;
    this.#pollIntervalMs = options.pollIntervalMs ?? 15000;
    this.#replaceMediaConnection = options.replaceMediaConnection;
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
      receiveStalls: this.#receiveProgress.observations,
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
    this.#remotePullRetries.delete(publicationId);
    this.remotePublicationsChanged();
  }
  remoteParticipantsChanged(participantIds: readonly string[]): void {
    this.#remoteParticipantIds = new Set(participantIds);
    this.#remoteParticipantRevision++;
    this.#remotePullIncomplete = true;
    this.remotePublicationsChanged();
  }
  remotePublicationsChanged(publications?: readonly MediaPublication[], projectionState: "available" | "unavailable" = "available"): void {
    if (projectionState === "unavailable") this.#receiveProgress.suspend();
    else if (publications) this.#receiveProgress.expect(publications, this.#participantId);
    if (this.#polling) {
      this.#pollAfterCurrent = true;
      return;
    }
    this.#clearPoll();
    this.#schedulePoll(0);
  }
  prepareLocalTrack(source: MediaPublicationSource, track: MediaStreamTrack): void {
    this.#requireActive();
    validateTrackSource(source, track);
    if (this.#localTracks.has(source)) throw new CloudflareSFUError(`A ${source} track is already prepared`, "media_failed");
    const reusable = [...this.#ownedPublications].find((item) => item.state.source === source && item.connection === this.#connection && item.lifecycle.kind === "confirmed");
    const state: LocalTrackState = {
      source,
      track,
      transceiver: reusable?.transceiver ?? null,
      providerPublicationId: reusable?.lifecycle.kind === "confirmed" ? reusable.lifecycle.handle.publicationId : null,
      desiredEnabled: false,
      enabled: false,
      endedListener: null,
      clearing: null,
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
  async clearPreparedLocalTrack(source: MediaPublicationSource, options: { readonly stopTrack?: boolean } = {}): Promise<void> {
    const state = this.#localTracks.get(source);
    if (!state) return;
    if (state.clearing) return state.clearing;
    state.clearing = this.#clearPreparedTrack(state, options.stopTrack);
    try {
      await state.clearing;
    } finally {
      state.clearing = null;
    }
  }
  async #clearPreparedTrack(state: LocalTrackState, stopTrack = true): Promise<void> {
    const source = state.source;
    if (source === "screen" || source === "screen_audio") {
      try {
        this.#pauseLocalSource(source, "capture_cleanup");
        await this.#retireOwnedPublications();
      } finally {
        this.#removeOwnedLocalTrack(state, stopTrack);
        if (this.#localTracks.get(source) === state) this.#localTracks.delete(source);
        this.#publishSnapshot();
        this.#emitLocal();
      }
      return;
    }
    if (state.enabled) await this.#disablePreparedTrack(state);
    if (this.#localTracks.get(source) !== state) return;
    this.#removeOwnedLocalTrack(state, stopTrack);
    this.#localTracks.delete(source);
    this.#publishSnapshot();
    this.#emitLocal();
  }
  async start(localMedia: MediaStream, beforePublish?: () => Promise<MediaStream>): Promise<void> {
    if (this.#started) return;
    this.#requireActive();
    const generation = this.#generation;
    this.#setPhase("connecting", null);
    if (beforePublish) {
      this.#receivingInitial = true;
      this.#schedulePoll(0);
      try {
        localMedia = await beforePublish();
      } finally {
        this.#receivingInitial = false;
      }
      // Startup rejection or Leave already owns cleanup; never publish after it.
      if (generation !== this.#generation || this.#stopped) return;
    }
    const tracks = localMedia.getTracks().filter((track) => track.kind === "audio" || track.kind === "video");
    for (const track of tracks) this.prepareLocalTrack(track.kind === "audio" ? "microphone" : "camera", track);
    await this.#activatePreparedTracks(
      [...this.#localTracks.values()].filter((state) => state.source === "microphone" || state.source === "camera"),
      generation,
    );
  }

  async refreshRemotePublications(): Promise<void> {
    if ((!this.#started && !this.#receivingInitial) || this.#stopped || this.#polling) return;
    this.#polling = true;
    const generation = this.#generation;
    this.#pollFailedPull = false;
    try {
      const transport = this.#requireTransport();
      const authoritative = await this.#signal(() => transport.listPublications());
      this.#requireGeneration(generation);
      await this.#reconcileRemotePublications(authoritative, generation);
      this.#requireGeneration(generation);
      if (!this.#remotePullIncomplete) this.#pollFailures = 0;
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#reportError(error);
      throw error;
    } finally {
      this.#finishPublicationPoll(generation);
    }
  }
  #finishPublicationPoll(generation: number): void {
    if (generation !== this.#generation) return;
    this.#polling = false;
    if (!this.#pollAfterCurrent) return;
    this.#pollAfterCurrent = false;
    this.#clearPoll();
    this.#schedulePoll(0);
  }
  async setLocalPublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    if (!target.enabled) return this.#pausePublicationTarget(target);
    const result = await this.#enablePublicationTarget(target);
    if (target.source !== "screen" || !this.#localTracks.has("screen_audio") || (result.outcome !== "confirmed" && result.outcome !== "satisfied")) return result;
    return this.#enablePublicationTarget({ ...target, source: "screen_audio" });
  }
  async #pausePublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind === "result" && resolved.result.outcome !== "satisfied") return resolved.result;
    const outcome = resolved.kind === "state" && resolved.value.enabled ? "confirmed" : "satisfied";
    if (target.source !== "screen" && this.#locallyPausedSources.get(target.source) === "capture_cleanup") {
      // Sync acknowledges unavailable capture without revoking its retained
      // publication. Explicit Off first records user_pause and still retires.
      await this.pauseLocalCapture(target.source);
      return { outcome, errorCode: null };
    }
    this.#pauseLocalSource(target.source);
    try {
      await this.#retireOwnedPublications();
      return { outcome, errorCode: null };
    } catch (error) {
      return mediaTargetFailure(error);
    }
  }
  async #enablePublicationTarget(target: Omit<MediaPlaneTarget, "source"> & { readonly source: MediaPublicationSource }): Promise<MediaPlaneResult> {
    const generation = this.#generation;
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind === "result") return resolved.result;
    const state = resolved.value;
    if (this.#locallyPausedSources.has(target.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    try {
      await this.#retireUnavailableLocalPublication(state);
      if (this.#locallyPausedSources.has(target.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
      if (state.enabled) return { outcome: "satisfied", errorCode: null };
      if (!(await this.#enablePreparedTrack(state))) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
      return { outcome: "confirmed", errorCode: null };
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#reportError(error);
      return mediaTargetFailure(error);
    }
  }
  async pauseLocalCapture(source: "microphone" | "camera"): Promise<void> {
    this.#locallyPausedSources.set(source, "capture_cleanup");
    const state = this.#localTracks.get(source);
    if (state) await this.#disablePreparedTrack(state);
  }
  setLocalSourceIntent(source: MediaPublicationSource, enabled: boolean, cause: LocalPublicationRetirementCause = "forced_pause"): Promise<void> {
    const sources = localSourceGroup(source);
    for (const item of sources) {
      if (enabled) this.#locallyPausedSources.delete(item);
      else this.#locallyPausedSources.set(item, cause);
    }
    if (!enabled) this.#pauseLocalSource(source, cause);
    return enabled ? Promise.resolve() : this.#retireOwnedPublications();
  }
  async closeForcedLocalPublication(source: MediaPublicationSource, cause: LocalPublicationRetirementCause = "forced_pause"): Promise<void> {
    const connection = this.#connection;
    const generationAtClose = this.#generation;
    const sources = localSourceGroup(source);
    const ownsPublication = [...this.#ownedPublications].some((item) => sources.includes(item.state.source));
    const canRecover = ownsPublication && this.#replaceMediaConnection !== undefined;
    let failedRetirement: Promise<void> | undefined;
    try {
      await this.setLocalSourceIntent(source, false, cause);
    } catch (error) {
      if (!canRecover) throw error;
      failedRetirement = this.#fenceFailedClose(error, connection, generationAtClose, cause);
      if (!failedRetirement) return;
    }
    if (!canRecover) return;
    await this.#restoreEnabledSourcesAfterClose(source);
    if (this.#retirement !== failedRetirement) await this.#retirement;
  }
  #fenceFailedClose(error: unknown, connection: RTCPeerConnection, generation: number, cause: LocalPublicationRetirementCause): Promise<void> | undefined {
    const failures: readonly unknown[] = error instanceof AggregateError ? error.errors : [error];
    if (!failures.every((failure) => this.#isRetryableConnectionFailure(failure))) throw error;
    // A late failure belongs to its issued connection, never its replacement.
    if (connection !== this.#connection || generation !== this.#generation) return;
    // The sender is detached and the provider's SDP outcome is uncertain.
    // Recover through the same owner as successful bundled-sender retirement.
    this.#retiredLocalConnection = connection;
    this.#retiredLocalCause = cause;
    return this.#retirement;
  }
  #restoreEnabledSourcesAfterClose(source: MediaPublicationSource): Promise<void> {
    const generation = this.#generation;
    return this.#serializeSDP(async () => {
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
    const authoritative = await this.#signal(() => this.#requireTransport().listPublications());
    if (authoritative.publications.some((publication) => publication.publicationId === publicationId)) return;
    // An authorized on target can precede the old forced-off projection.
    // Never satisfy it from a browser slot whose provider track is gone.
    if (state.providerPublicationId === publicationId) {
      this.#pauseLocalSource(state.source, "discovery_absent");
      await this.#retireOwnedPublications();
    }
  }
  #pauseLocalSource(source: MediaPublicationSource, cause: LocalPublicationRetirementCause = "forced_pause"): void {
    const sources = localSourceGroup(source);
    for (const publication of this.#ownedPublications) {
      if (!sources.includes(publication.state.source)) continue;
      this.#markPublicationRetiring(publication, cause);
    }
    for (const state of this.#localTracks.values()) {
      if (!sources.includes(state.source)) continue;
      state.desiredEnabled = false;
      this.#clearLocalPublication(state);
    }
    this.#publishSnapshot();
    this.#emitLocal();
  }
  #retireOwnedPublications(reportFailure: (error: unknown) => void = this.#reportError.bind(this)): Promise<void> {
    const publications = [...this.#ownedPublications].filter((item) => item.lifecycle.kind === "retiring" && item.lifecycle.handle);
    const retirement = (async () => {
      const errors: unknown[] = [];
      for (const publication of publications) {
        try {
          await this.#serializeSDP(() => this.#closeOwnedPublication(publication), true);
        } catch (error) {
          errors.push(error);
          if (!this.#stopped) reportFailure(error);
        }
      }
      if (this.#stopped && this.#ownedPublications.size === 0) this.#transport = undefined;
      if (errors.length) throw new AggregateError(errors, "Media retirement failed");
    })();
    // Observe shutdown and intent callers even when they do not await cleanup.
    void retirement.catch(() => {});
    return (this.#retirement = retirement);
  }
  #markPublicationRetiring(publication: OwnedLocalPublication, cause: LocalPublicationRetirementCause = "publish_failure"): void {
    const phase = publication.lifecycle;
    if (phase.kind === "pending" || phase.kind === "confirmed") publication.lifecycle = { kind: "retiring", handle: phase.kind === "confirmed" ? phase.handle : null, detached: false, cause };
  }
  #markBundledTransportRetiring(publication: OwnedLocalPublication): void {
    // Real SFU probe (2026-10-30): closing BUNDLE MID 0 caused 410
    // session_error; closing MID 1 kept MID 0 and the session working.
    // Follow the negotiated BUNDLE tag, since the first sender can be video.
    // Missing bundle information retains the conservative rebuild behavior.
    const bundleTag = /(?:^|\r?\n)a=group:BUNDLE[ \t]+(\S+)/.exec(publication.connection.localDescription?.sdp ?? "")?.[1];
    if (!bundleTag || (publication.transceiver.mid !== null && publication.transceiver.mid === bundleTag)) {
      if (this.#retiredLocalConnection === publication.connection) return;
      this.#retiredLocalConnection = publication.connection;
      if (publication.lifecycle.kind === "retiring") this.#retiredLocalCause = publication.lifecycle.cause;
    }
  }
  async #closeOwnedPublication(publication: OwnedLocalPublication): Promise<void> {
    const phase = publication.lifecycle;
    if (phase.kind !== "retiring" || !phase.handle) return;
    const handle = phase.handle;
    const { connection, connectionId, transceiver, state } = publication;
    this.#markBundledTransportRetiring(publication);
    let closed = connection.connectionState === "closed";
    try {
      if (!phase.detached && !closed) {
        await this.#boundPeerOperation(transceiver.sender.replaceTrack(null));
        closed = connection.connectionState === "closed";
        if (!closed) transceiver.stop();
      }
      phase.detached = true;
      const sessionDescription = closed ? undefined : await createLocalOffer(connection);
      const response = await this.#signal(() => this.#requireTransport().closeTracks({ connectionId, sessionDescription, tracks: [{ ...handle, source: state.source }], force: closed }), { generation: this.#generation, connectionId });
      // The API has committed the disabled observation even if applying SDP fails.
      publication.lifecycle = { kind: "retired" };
      this.#ownedPublications.delete(publication);
      if (connection.connectionState !== "closed") await this.#applyProviderDescription(response, connection);
    } catch (error) {
      await this.#rollbackLocalOffer(connection);
      throw error;
    }
  }
  #fenceLocalPublications(): void {
    for (const publication of this.#ownedPublications) publication.lifecycle = { kind: "retired" };
    this.#ownedPublications.clear();
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
    if (options.bootstrap.connectionId !== this.#bootstrap.connectionId) {
      this.#fenceLocalPublications();
      this.#replacementCause = "access_refresh";
    }
    const generation = ++this.#generation;
    const connectionEpoch = ++this.#connectionEpoch;
    this.#polling = false;
    this.#pollAfterCurrent = false;
    this.#clearPoll();
    this.#remotePullRetries.clear();
    this.#disposeConnection(false);
    for (const publication of this.#ownedPublications) this.#markPublicationRetiring(publication);
    void this.#retireOwnedPublications();
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#negotiatedGeneration = null;
    this.#replacementAttemptedGeneration = options.bootstrap.connectionId !== this.#bootstrap.connectionId ? generation : null;
    // Fresh access already replaced the expired SFU connection. Replacing it
    // again before its first offer adds a serial request and abandons that connection.
    if (options.bootstrap.connectionId !== this.#bootstrap.connectionId) this.#started = false;
    this.#bootstrap = options.bootstrap;
    if (options.transport) this.#transport = options.transport;
    this.#rebuildPeerConnection(options.bootstrap, generation, connectionEpoch);
    for (const state of this.#localTracks.values()) {
      state.transceiver = null;
      state.enabled = false;
    }
    const enabled = [...this.#localTracks.values()].filter((state) => state.desiredEnabled && state.track.readyState !== "ended");
    await this.#activatePreparedTracks(enabled, generation);
  }
  async #activatePreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    try {
      await this.#publishPreparedTracks(states, generation);
      this.#requireGeneration(generation);
      if (this.#remoteRecoveryGeneration !== generation) this.#replacementAttemptedGeneration = null;
      this.#started = true;
      this.#setPhase("live", null);
      this.#schedulePoll(0);
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#setFailure(error, "media_failed");
      throw error;
    }
  }
  stop(): void {
    if (this.#stopped) {
      void this.#retireOwnedPublications();
      return;
    }
    this.#stopped = true;
    this.#receiveProgress.expect([], this.#participantId);
    this.#subscribedPublicationIds.clear();
    this.#generation++;
    this.#connectionEpoch++;
    this.#clearPoll();
    this.#remotePullRetries.clear();
    this.#polling = false;
    this.#pollAfterCurrent = false;
    this.#disposeConnection(true);
    for (const publication of this.#ownedPublications) this.#markPublicationRetiring(publication);
    this.#clearRemoteTracks();
    for (const state of this.#localTracks.values()) {
      state.track.enabled = false;
      this.#removeOwnedLocalTrack(state);
    }
    this.#localTracks.clear();
    void this.#retireOwnedPublications();
    this.#started = false;
    this.#cursor = null;
    this.#publishSnapshot("stopped", null);
    this.#emitLocal();
    this.#emitRemote();
    this.#localListeners.clear();
    this.#remoteListeners.clear();
    this.#snapshotListeners.clear();
  }
  async #enablePreparedTrack(state: LocalTrackState): Promise<boolean> {
    const generation = this.#generation;
    try {
      await this.#retireExpiredCapture(state);
      if (this.#locallyPausedSources.has(state.source)) return false;
      state.desiredEnabled = true;
      state.track.enabled = true;
      if (state.providerPublicationId && state.transceiver) return await this.#reattachLocalTrack(state, state.transceiver);
      await this.#publishPreparedTracks([state], generation);
      // A completed local request restores the budget, except while a remote
      // recovery that spent it is still unresolved: restoring it then lets every
      // poll replace the healthy connection again for the same bad publication.
      if (this.#remoteRecoveryGeneration !== generation) this.#replacementAttemptedGeneration = null;
      return state.enabled;
    } catch (error) {
      if (generation === this.#generation) {
        this.#pauseLocalSource(state.source, "enable_failure");
        await this.#retireOwnedPublications().catch(() => {});
      }
      throw error;
    }
  }
  async #retireExpiredCapture(state: LocalTrackState): Promise<void> {
    const publication = [...this.#ownedPublications].find((item) => item.transceiver === state.transceiver && item.lifecycle.kind === "confirmed");
    if (!publication || publication.detachedAt === null || Date.now() - publication.detachedAt < CAPTURE_REUSE_WINDOW_MS) return;
    this.#pauseLocalSource(state.source, "capture_cleanup");
    try {
      await this.#retireOwnedPublications((error) => {
        if (!this.#isExpiredRetiredConnection(error)) this.#reportError(error);
      });
    } catch (error) {
      if (!this.#isExpiredRetiredConnection(error)) throw error;
      // The provider says this binding is gone. Fence it before another
      // retirement pass can report the expected 410 to lifecycle recovery.
      this.#fenceLocalPublications();
    }
  }
  #isExpiredRetiredConnection(error: unknown): boolean {
    if (!this.#replaceMediaConnection || this.#retiredLocalConnection !== this.#connection) return false;
    if (error instanceof AggregateError) return error.errors.every((cause: unknown) => this.#isRetryableConnectionFailure(cause));
    return this.#isRetryableConnectionFailure(error);
  }
  async #reattachLocalTrack(state: LocalTrackState, transceiver: RTCRtpTransceiver): Promise<boolean> {
    await this.#boundPeerOperation(transceiver.sender.replaceTrack(state.track));
    const cause = this.#locallyPausedSources.get(state.source);
    state.enabled = cause === undefined;
    state.desiredEnabled = state.enabled;
    state.track.enabled = state.enabled;
    if (cause === "capture_cleanup") await this.#disablePreparedTrack(state);
    else if (cause) {
      this.#pauseLocalSource(state.source, cause);
      await this.#retireOwnedPublications();
    } else {
      for (const publication of this.#ownedPublications) if (publication.transceiver === transceiver) publication.detachedAt = null;
    }
    this.#publishSnapshot();
    this.#emitLocal();
    return state.enabled;
  }
  async #disablePreparedTrack(state: LocalTrackState): Promise<void> {
    const transceiver = state.transceiver;
    for (const publication of this.#ownedPublications) {
      if (publication.transceiver === transceiver && publication.lifecycle.kind === "confirmed") publication.detachedAt ??= Date.now();
    }
    state.desiredEnabled = false;
    state.track.enabled = false;
    // Queue the detach before notifying consumers, but never wait to expose off.
    const detach = transceiver ? this.#boundPeerOperation(transceiver.sender.replaceTrack(null)) : Promise.resolve();
    state.enabled = false;
    this.#publishSnapshot();
    this.#emitLocal();
    await detach;
  }
  async #publishPreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    if (states.length === 0) return;
    try {
      await this.#serializeSDP(async () => {
        const pending = await this.#prepareConnectionForPublication(states, generation);
        try {
          await this.#publishPreparedTracksSerialized(pending, generation, this.#connection, this.#bootstrap.connectionId);
        } catch (error) {
          if (!this.#replaceMediaConnection || !this.#isRetryableConnectionFailure(error) || this.#replacementAttemptedGeneration === generation) throw error;
          await this.#replaceMediaConnectionForRecovery(generation, "local_signaling_failure");
          await this.#publishPreparedTracksSerialized(
            [...this.#localTracks.values()].filter((state) => (state.desiredEnabled || states.includes(state)) && state.track.readyState !== "ended"),
            generation,
            this.#connection,
            this.#bootstrap.connectionId,
          );
        }
      });
    } finally {
      // Cleanup reports its own failures; another source cannot revoke this enable.
      await this.#retirement.catch(() => {});
    }
  }
  async #prepareConnectionForPublication(states: readonly LocalTrackState[], generation: number): Promise<readonly LocalTrackState[]> {
    if (this.#retiredLocalConnection !== this.#connection || !this.#replaceMediaConnection) {
      await this.#replaceDormantConnectionBeforeNegotiation(generation);
      return states;
    }
    // Retiring the bundled sender can expire the Cloudflare SFU connection.
    // Rebuild before publishing, retaining only other provider-authorized sources.
    const authoritative = await this.#signal(() => this.#requireTransport().listPublications());
    this.#pauseUnavailableOtherSources(authoritative.publications, states);
    this.#replacementAttemptedGeneration = null;
    await this.#replaceMediaConnectionForRecovery(generation, this.#retiredLocalCause);
    return [...this.#localTracks.values()].filter((state) => (state.desiredEnabled || states.includes(state)) && state.track.readyState !== "ended");
  }
  #pauseUnavailableOtherSources(publications: readonly CloudflareSFUPublication[], states: readonly LocalTrackState[]): void {
    for (const state of this.#localTracks.values()) {
      if (states.includes(state) || !state.providerPublicationId) continue;
      if (publications.some((publication) => publication.publicationId === state.providerPublicationId)) continue;
      this.#pauseLocalSource(state.source, "discovery_absent");
    }
    void this.#retireOwnedPublications();
  }
  async #publishPreparedTracksSerialized(states: readonly LocalTrackState[], generation: number, connection: RTCPeerConnection, connectionId: string): Promise<void> {
    this.#requireGeneration(generation);
    const pendingStates = states.filter((state) => !state.enabled);
    if (pendingStates.length === 0) return;
    const wasLive = connectionIsLive(connection);
    const publications: OwnedLocalPublication[] = [];
    try {
      for (const state of pendingStates) publications.push(await this.#prepareLocalPublication(connection, state, generation));
      await this.#negotiateLocalPublications(connection, connectionId, publications, generation);
      if (!wasLive) await this.#waitForConnection(connection, generation);
      this.#requireGeneration(generation);
      this.#negotiatedGeneration = generation;
      this.#settleLocalPublications(publications);
      this.#publishSnapshot();
      this.#emitLocal();
    } catch (error) {
      await this.#rollbackLocalOffer(connection);
      for (const publication of publications) this.#markPublicationRetiring(publication);
      this.#settleLocalPublications(publications);
      throw error;
    } finally {
      void this.#retireOwnedPublications();
    }
  }
  async #prepareLocalPublication(connection: RTCPeerConnection, state: LocalTrackState, generation: number): Promise<OwnedLocalPublication> {
    const transceiver = state.transceiver ?? this.#addLocalTransceiver(connection, state);
    const publication: OwnedLocalPublication = { state, transceiver, trackName: `${state.source}-${globalThis.crypto.randomUUID()}`, connection, connectionId: this.#bootstrap.connectionId, detachedAt: null, lifecycle: { kind: "pending" } };
    this.#ownedPublications.add(publication);
    if (state.transceiver) await this.#boundPeerOperation(transceiver.sender.replaceTrack(state.track));
    this.#requireGeneration(generation);
    state.transceiver = transceiver;
    return publication;
  }
  #addLocalTransceiver(connection: RTCPeerConnection, state: LocalTrackState): RTCRtpTransceiver {
    if (state.source !== "camera" || firefoxCameraSimulcastUnsupported()) return connection.addTransceiver(state.track, { direction: "sendonly" });
    // 720p and 360p have a 4:1 pixel ratio; budget about 4:1 bandwidth.
    // Match a single-stream camera's temporal mode so h does not spend
    // its constrained uplink budget on extra temporal-layer overhead.
    const sendEncodings = [
      { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2500000, scalabilityMode: "L1T1" },
      { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650000, scalabilityMode: "L1T1" },
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
  async #negotiateLocalPublications(connection: RTCPeerConnection, connectionId: string, publications: readonly OwnedLocalPublication[], generation: number): Promise<void> {
    let sessionDescription: Awaited<ReturnType<typeof createLocalOffer>>;
    try {
      sessionDescription = await createLocalOffer(connection);
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
      sessionDescription = await createLocalOffer(connection);
    }
    const tracks = publications.map(
      ({ state, transceiver, trackName }): CloudflareSFUTrackRequest => ({
        location: "local",
        mid: requireTransceiverMid(transceiver),
        trackName,
        source: state.source,
      }),
    );
    const response = await this.#signal(() => this.#addTracks({ connectionId, sessionDescription, tracks }), { generation, connectionId });
    this.#recordLocalPublicationHandles(publications, response.tracks);
    this.#requireGeneration(generation);
    await this.#applyProviderDescription(response, connection);
  }
  #recordLocalPublicationHandles(publications: readonly OwnedLocalPublication[], tracks: readonly CloudflareSFUTrackRequest[] | undefined): void {
    for (const publication of publications) {
      const { state, transceiver, lifecycle } = publication;
      if (lifecycle.kind === "retired") continue;
      const authoritative = tracks?.find((track) => track.location === "local" && track.mid === transceiver.mid && track.source === state.source);
      if (!authoritative?.publicationId) throw new CloudflareSFUError("Missing publication ID", "invalid_publication");
      const handle = { publicationId: authoritative.publicationId, mid: requireTransceiverMid(transceiver) };
      publication.lifecycle = lifecycle.kind === "retiring" ? { ...lifecycle, handle } : { kind: "confirmed", handle };
    }
  }
  #settleLocalPublications(publications: readonly OwnedLocalPublication[]): void {
    for (const publication of publications) {
      const { state, transceiver, lifecycle } = publication;
      if (lifecycle.kind === "retired") continue;
      if (lifecycle.kind === "confirmed" && state.transceiver === transceiver && !this.#locallyPausedSources.has(state.source)) {
        state.enabled = true;
        state.desiredEnabled = true;
        state.track.enabled = true;
        state.providerPublicationId = lifecycle.handle.publicationId;
        continue;
      }
      this.#markPublicationRetiring(publication, this.#locallyPausedSources.get(state.source) ?? "publish_failure");
      if (state.transceiver === transceiver) {
        this.#clearLocalPublication(state);
      }
    }
  }
  #clearLocalPublication(state: LocalTrackState): void {
    state.transceiver = null;
    state.providerPublicationId = null;
    state.enabled = false;
    state.track.enabled = false;
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
    const cursor = this.#nextRemotePublicationCursor(authoritative);
    if (cursor === null) return;
    const participantRevision = this.#remoteParticipantRevision;
    const desired = this.#desiredRemotePublications(authoritative, cursor);
    this.#pollFailedPull = true;
    const pulled = await this.#pullWithRecovery(desired, cursor, generation);
    if (pulled === null) return;
    this.#requireGeneration(generation);
    const next = reconcileRemoteTracks(desired, pulled, this.#remoteTracks);
    stopReplacedRemoteTracks(this.#remoteTracks, next, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    for (const [key, publication] of next) this.#remoteTracks.set(key, publication);
    this.#cursor = cursor;
    this.#remotePullIncomplete = participantRevision !== this.#remoteParticipantRevision || next.size !== desired.size;
    if (!this.#remotePullIncomplete) this.#remoteRecoveryGeneration = null;
    if (!this.#remotePullIncomplete && this.#hasLiveRemoteTracks()) this.#replacementAttemptedGeneration = null;
    for (const publication of pulled) {
      this.#subscribedPublicationIds.add(publication.publicationId);
      this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    }
    this.#publishSnapshot();
    this.#emitRemote();
  }
  #pendingRemotePulls(desired: ReadonlyMap<string, CloudflareSFUPublication>): CloudflareSFUPublication[] {
    const desiredIds = new Set([...desired.values()].map((publication) => publication.publicationId));
    for (const publicationId of this.#remotePullRetries.keys()) {
      if (!desiredIds.has(publicationId)) this.#remotePullRetries.delete(publicationId);
    }
    for (const publicationId of this.#subscribedPublicationIds) {
      if (!desiredIds.has(publicationId)) this.#subscribedPublicationIds.delete(publicationId);
    }
    const now = Date.now();
    return [...desired]
      .filter(([key, publication]) => {
        if (this.#remoteTracks.get(key)?.publicationId === publication.publicationId) {
          if (!this.#receiveProgress.canRepull(publication.publicationId) && !(this.#replaceMediaConnection && this.#receiveProgress.canRebuild(publication.publicationId))) return false;
        }
        const remaining = (this.#remotePullRetries.get(publication.publicationId)?.retryAfter ?? 0) - now;
        return remaining <= 0;
      })
      .map(([, publication]) => publication);
  }
  #nextRemotePublicationCursor(authoritative: CloudflareSFUPublicationSnapshot): PublicationCursor | null {
    if (this.#cursor?.signature === INVALID_PUBLICATION_SIGNATURE && this.#cursor.incarnation === authoritative.incarnation && this.#cursor.sequence === authoritative.sequence) return null;
    let cursor: PublicationCursor;
    try {
      cursor = validatePublicationSnapshot(authoritative);
    } catch (error) {
      this.#quarantineInvalidRemotePublicationCursor(authoritative);
      throw error;
    }
    const ordering = comparePublicationCursor(this.#cursor, cursor);
    return ordering === "stale" || (ordering === "same" && !this.#remotePullIncomplete) ? null : cursor;
  }
  #desiredRemotePublications(authoritative: CloudflareSFUPublicationSnapshot, cursor: PublicationCursor): ReturnType<typeof desiredRemotePublications> {
    try {
      // Sync disconnection does not end an already-playing media track.
      // It does exclude abandoned participants from new subscriptions.
      const publications = authoritative.publications.filter((publication) => this.#canSubscribeToRemotePublication(publication));
      return desiredRemotePublications(publications, this.#participantId);
    } catch (error) {
      this.#observeRemotePublicationCursor(cursor);
      throw error;
    }
  }
  #canSubscribeToRemotePublication(publication: CloudflareSFUPublication): boolean {
    return this.#remoteParticipantIds === null || this.#remoteParticipantIds.has(publication.participantId) || this.#subscribedPublicationIds.has(publication.publicationId);
  }
  async #pullWithRecovery(desired: ReadonlyMap<string, CloudflareSFUPublication>, cursor: PublicationCursor, generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    const pending = this.#pendingRemotePulls(desired);
    const stalled = pending.filter((publication) => this.#receiveProgress.isStalled(publication.publicationId));
    if (stalled.length) return this.#recoverStalledRemotePublications(stalled, desired, cursor, generation);
    const publications = pending;
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
  async #recoverStalledRemotePublications(stalled: readonly CloudflareSFUPublication[], desired: ReadonlyMap<string, CloudflareSFUPublication>, cursor: PublicationCursor, generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    if (stalled.every((publication) => this.#receiveProgress.canRepull(publication.publicationId))) {
      try {
        return await this.#repullStalledRemotePublications(stalled, generation);
      } catch (error) {
        this.#requireGeneration(generation);
        if (!this.#replaceMediaConnection) throw error;
      }
    }
    if (!this.#replaceMediaConnection || !this.#receiveProgress.reserveRebuild()) return [];
    return this.#retryRemotePullOnReplacement([...desired.values()], cursor, generation, "receive_stalled");
  }
  async #repullStalledRemotePublications(stalled: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    for (const publication of stalled) this.#receiveProgress.reserveRepull(publication.publicationId);
    const retired = await this.#retireStalledReceivers(stalled, generation);
    if (!retired.length) return [];
    const pulled = await this.#pullBatch(retired, generation);
    if (pulled?.length !== retired.length) throw new CloudflareSFUError("Stalled receive subscriptions were not restored", "media_failed");
    for (const publication of retired) this.#receiveProgress.restarted(publication.publicationId);
    return pulled;
  }
  async #retireStalledReceivers(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFUPublication[]> {
    return this.#serializeSDP(async () => {
      this.#requireGeneration(generation);
      const stalled = publications.filter((publication) => this.#receiveProgress.isStalled(publication.publicationId));
      if (!stalled.length) return [];
      const connection = this.#connection;
      const receivers = stalled.map((publication) => {
        const remote = [...this.#remoteTracks.values()].find((track) => track.publicationId === publication.publicationId);
        const transceiver = connection.getTransceivers().find((item) => item.receiver.track === remote?.track);
        if (!transceiver || transceiver.mid === null) throw new CloudflareSFUError("The stalled receiver has no negotiated MID", "media_failed");
        return { publication, transceiver, mid: transceiver.mid };
      });
      const connectionId = this.#bootstrap.connectionId;
      await this.#signal(() => this.#requireTransport().closeTracks({ connectionId, receiveOnly: true, force: true, tracks: receivers.map(({ publication, mid }) => ({ mid, source: publication.source, publicationId: publication.publicationId })) }), { generation, connectionId });
      this.#requireGeneration(generation);
      for (const { transceiver } of receivers) transceiver.stop();
      return stalled;
    });
  }
  #canReplaceConnectionAfterRemotePull(error: unknown, generation: number): boolean {
    const gone = error instanceof CloudflareSFUError && (error.options.status === 404 || error.options.status === 410);
    return this.#isRetryableConnectionFailure(error) && (gone || !this.#hasLiveRemoteTracks()) && this.#replaceMediaConnection !== undefined && this.#replacementAttemptedGeneration !== generation;
  }
  #hasLiveRemoteTracks(): boolean {
    return [...this.#remoteTracks.values()].some((publication) => publication.track.readyState === "live");
  }
  async #retryRemotePullOnReplacement(publications: readonly CloudflareSFUPublication[], cursor: PublicationCursor, generation: number, cause: MediaConnectionReplacementCause = "remote_signaling_failure"): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    this.#remoteRecoveryGeneration = generation;
    const connection = this.#connection;
    try {
      await this.#replaceMediaConnectionForRecovery(generation, cause);
      await this.#republishPreparedTracksAfterRecovery(generation);
      return await this.#pull(publications, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      if (cause === "receive_stalled" && connection === this.#connection) {
        this.#replacementAttemptedGeneration = null;
        for (const publication of publications) this.#backoffRemotePull(publication.publicationId, true);
      }
      this.#observeRemotePublicationCursor(cursor, retryableRemotePull(error));
      throw error;
    }
  }
  async #pull(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[] | null> {
    const eligible = publications.filter((publication) => this.#canSubscribeToRemotePublication(publication));
    try {
      return await this.#pullBatch(eligible, generation);
    } catch (error) {
      this.#requireGeneration(generation);
      if (eligible.length <= 1 || !retryableRemotePull(error) || isRateLimited(error) || this.#canReplaceConnectionAfterRemotePull(error, generation) || (error instanceof CloudflareSFUError && (error.options.status === 404 || error.options.status === 410))) {
        this.#deferRemotePulls(eligible, error);
        throw error;
      }
    }
    return this.#pullIndividually(eligible, generation);
  }
  async #pullIndividually(eligible: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[]> {
    const pulled: CloudflareSFURemoteTrack[] = [];
    let failure: unknown;
    // Healthy subscriptions stay batched; isolate only a failed batch.
    for (const [index, publication] of eligible.entries()) {
      if (!this.#canSubscribeToRemotePublication(publication)) continue;
      try {
        pulled.push(...(await this.#pullBatch([publication], generation)));
      } catch (error) {
        this.#requireGeneration(generation);
        this.#deferRemotePulls([publication], error);
        this.#reportError(error);
        if (failure === undefined || retryableRemotePull(error)) failure = error;
        if (isRateLimited(error)) {
          this.#deferRemotePulls(eligible.slice(index + 1), error);
          break;
        }
      }
    }
    if (failure && pulled.length === 0) throw failure;
    return pulled;
  }
  #deferRemotePulls(publications: readonly CloudflareSFUPublication[], error: unknown): void {
    const retryAfter = retryableRemotePull(error) ? Date.now() + 15_000 : Number.POSITIVE_INFINITY;
    for (const publication of publications) {
      const failures = this.#remotePullRetries.get(publication.publicationId)?.failures ?? 0;
      this.#remotePullRetries.set(publication.publicationId, { retryAfter, failures, receiveStalled: this.#remotePullRetries.get(publication.publicationId)?.receiveStalled });
    }
  }
  async #pullBatch(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[]> {
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
        const response = await this.#signal(() => this.#addTracks({ connectionId, tracks: requested, allowPartialRemoteTracks: true }), {
          generation,
          connectionId,
        });
        this.#requireGeneration(generation);
        this.#recordRemotePullErrors(publications, response.trackErrors ?? []);
        const responseTracks = response.tracks ?? [];
        const matched = matchRemotePullTracks(publications, responseTracks);
        for (const { publication } of matched) {
          if (!this.#remotePullRetries.get(publication.publicationId)?.receiveStalled) this.#remotePullRetries.delete(publication.publicationId);
        }
        await this.#completeRenegotiation(response, connection, connectionId, generation);
        if (matched.length === 0) return [];
        await this.#waitForConnection(connection, generation);
        this.#negotiatedGeneration = generation;
        await (() => waitFor(() => responseTracks.every((track) => track.mid !== undefined && received.has(track.mid)), 5000))();
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
      // A republished track can be discovered before the provider can pull it.
      // Keep its backoff independent of polls restarted by unrelated presence.
      this.#backoffRemotePull(publication.publicationId);
      this.#reportError(new CloudflareSFUError(`Cloudflare SFU remote track failed: ${failure.code}`, "media_failed", { providerCode: failure.code }));
    }
  }
  #backoffRemotePull(publicationId: string, receiveStalled = false): void {
    const previous = this.#remotePullRetries.get(publicationId) ?? { retryAfter: 0, failures: 0 };
    const failures = Math.min(previous.failures + 1, 6);
    this.#remotePullRetries.set(publicationId, { retryAfter: Date.now() + Math.min(15_000, 750 * 2 ** (failures - 1)), failures, receiveStalled: receiveStalled || previous.receiveStalled });
  }
  #adaptViewerLayers(connection: RTCPeerConnection, report: RTCStatsReport, selector: ViewerLayerSelector, current: () => boolean): void {
    if (!this.#transport?.updateTracks || !this.#canObserveReceiveProgress(connection)) return;
    const now = performance.now();
    const cameras = [...this.#remoteTracks.values()].filter(({ source, track }) => source === "camera" && track.readyState === "live");
    const changes = selector.sample(now, report, cameras);
    const active = new Set(changes.map(({ publicationId }) => publicationId));
    for (const id of this.#viewerLayerPending.keys()) if (!active.has(id)) this.#viewerLayerPending.delete(id);
    for (const change of changes) this.#viewerLayerPending.set(change.publicationId, change);
    if (this.#viewerLayerUpdating || now < this.#viewerLayerUpdateAt) return;
    const batch = [...this.#viewerLayerPending.values()]
      .flatMap((change) => {
        const mid = connection.getTransceivers().find((transceiver) => transceiver.receiver.track === change.track)?.mid;
        return mid === null || mid === undefined ? [] : [{ change, mid }];
      })
      .slice(0, VIEWER_LAYER_BATCH_SIZE);
    if (!batch.length) return;
    this.#viewerLayerUpdating = true;
    this.#viewerLayerUpdateAt = now + VIEWER_LAYER_UPDATE_INTERVAL_MS;
    void this.#requestViewerLayers(this.#transport, batch).then((failed) => {
      this.#viewerLayerUpdating = false;
      if (!current()) return;
      for (const { change } of batch) {
        const pending = this.#viewerLayerPending.get(change.publicationId);
        if (pending?.track === change.track && pending.layer === change.layer) this.#viewerLayerPending.delete(change.publicationId);
        if (failed.has(change.publicationId)) selector.failed(change, performance.now());
        else selector.applied(change);
      }
    });
  }
  // A layer switch is an optimization: when the SFU refuses it, the pulled layer keeps playing.
  async #requestViewerLayers(transport: CloudflareSFUSignalingTransport, batch: readonly { readonly change: ViewerLayerChange; readonly mid: string }[]): Promise<ReadonlySet<string>> {
    try {
      const response = await transport.updateTracks?.({
        connectionId: this.#bootstrap.connectionId,
        tracks: batch.map(({ change, mid }) => {
          const { connectionId, trackName } = parseCloudflareSFUPublicationID(change.publicationId);
          return { location: "remote", mid, sessionId: connectionId, trackName, simulcast: { preferredRid: change.layer, priorityOrdering: "none", ridNotAvailable: "asciibetical" } };
        }),
      });
      return new Set(
        batch
          .filter(({ change }) => {
            const { connectionId, trackName } = parseCloudflareSFUPublicationID(change.publicationId);
            return response?.trackErrors?.some((error) => error.connectionId === connectionId && error.trackName === trackName);
          })
          .map(({ change }) => change.publicationId),
      );
    } catch {
      return new Set(batch.map(({ change }) => change.publicationId));
    }
  }
  #canObserveReceiveProgress(connection: RTCPeerConnection): boolean {
    return this.#started && connectionIsLive(connection) && (typeof document === "undefined" || document.visibilityState !== "hidden");
  }
  #observeReceiveProgress(connection: RTCPeerConnection, report: RTCStatsReport): void {
    if (!this.#canObserveReceiveProgress(connection)) {
      this.#receiveProgress.clear();
      return;
    }
    const { stalled, advanced } = this.#receiveProgress.sample(performance.now(), connection, report, this.#remoteTracks.values());
    for (const publicationId of advanced) this.#remotePullRetries.delete(publicationId);
    this.#publishSnapshot();
    if (!stalled.some((id) => this.#receiveProgress.canRepull(id) || (this.#replaceMediaConnection && this.#receiveProgress.canRebuild(id)))) return;
    for (const publicationId of stalled) {
      if (!this.#remotePullRetries.get(publicationId)?.receiveStalled) this.#backoffRemotePull(publicationId, true);
    }
    this.#remotePullIncomplete = true;
    this.remotePublicationsChanged();
  }
  async #completeRenegotiation(response: CloudflareSFUTracksResponse, connection: RTCPeerConnection, connectionId: string, generation: number): Promise<void> {
    if (!response.requiresImmediateRenegotiation) return;
    await this.#applyProviderDescription(response, connection);
    const answer = await (() => connection.createAnswer())();
    await (() => connection.setLocalDescription(answer))();
    await this.#signal(() => this.#requireTransport().renegotiate({ connectionId, sessionDescription: requireDescription(answer) }), { generation, connectionId });
    this.#requireGeneration(generation);
  }
  async #applyProviderDescription(response: CloudflareSFUTracksResponse, connection = this.#connection): Promise<void> {
    await (() => connection.setRemoteDescription(requireSFUDescription(response.sessionDescription)))();
  }
  #serializeSDP<T>(operation: () => Promise<T>, retirement = false): Promise<T> {
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
      if (expired || (!retirement && generation !== this.#generation)) throw timeout;
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
    return (() =>
      waitFor(
        () => {
          this.#requireGeneration(generation);
          return connectionIsLive(connection);
        },
        CONNECTION_TIMEOUT_MS,
        "Timed out waiting for the Cloudflare SFU peer connection",
      ))();
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
    const viewerLayers = new ViewerLayerSelector();
    let observedCamera: LocalTrackState | undefined;
    const current = () => !disposed && generation === this.#generation && connectionEpoch === this.#connectionEpoch && !this.#stopped && connection.connectionState !== "failed" && connection.connectionState !== "closed";
    const adaptCamera = async () => {
      if (!current()) return;
      try {
        const state = this.#localTracks.get("camera");
        if (state !== observedCamera) {
          cameraPolicy.reset();
          observedCamera = state;
        }
        const report = await connection.getStats();
        if (!current() || connection.signalingState !== "stable") return;
        this.#observeReceiveProgress(connection, report);
        this.#adaptViewerLayers(connection, report, viewerLayers, current);
        const sender = this.#cameraSimulcastSender(state);
        if (!sender) cameraPolicy.reset();
        else await this.#applyCameraUplink(sender, report, cameraPolicy);
      } catch {
        // Stats and optional sender controls must never break publication.
        cameraPolicy.reset();
      } finally {
        if (current()) cameraTimer = globalThis.setTimeout(adaptCamera, 1000);
      }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.#viewerLayerPending.clear();
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
      if (connection.connectionState === "closed") dispose();
    };
    this.#disposeConnectionObservation = dispose;
    cameraTimer = globalThis.setTimeout(adaptCamera, 1000);
    connection.addEventListener("connectionstatechange", capture);
    connection.addEventListener("iceconnectionstatechange", capture);
    connection.addEventListener("signalingstatechange", capture);
    capture();
  }
  async #replaceDormantConnectionBeforeNegotiation(generation: number): Promise<void> {
    if (!this.#started || this.#negotiatedGeneration === generation || this.#replacementAttemptedGeneration === generation || !this.#replaceMediaConnection) return;
    await this.#replaceMediaConnectionForRecovery(generation, "dormant_connection");
  }
  #addTracks(input: Omit<Parameters<CloudflareSFUSignalingTransport["addTracks"]>[0], "replacementCause">): Promise<CloudflareSFUTracksResponse> {
    // The first signaling attempt on the new binding reports its origin, even if
    // that attempt fails. Extra query parameters also work with older APIs.
    const replacementCause = this.#replacementCause;
    this.#replacementCause = undefined;
    return this.#requireTransport().addTracks({ ...input, replacementCause });
  }
  async #replaceMediaConnectionForRecovery(generation: number, cause: MediaConnectionReplacementCause): Promise<void> {
    this.#requireGeneration(generation);
    if (!this.#replaceMediaConnection || this.#replacementAttemptedGeneration === generation) {
      throw new CloudflareSFUError("A fresh Cloudflare SFU connection is unavailable", "signaling_failed");
    }
    this.#replacementAttemptedGeneration = generation;
    const replaceMediaConnection = this.#replaceMediaConnection;
    const bootstrap = await replaceMediaConnection();
    this.#requireGeneration(generation);
    validateBootstrap(bootstrap);
    if (bootstrap.connectionId === this.#bootstrap.connectionId) {
      throw new CloudflareSFUError("Participant access did not replace the Cloudflare SFU connection", "signaling_failed");
    }
    this.#fenceLocalPublications();
    const connectionEpoch = ++this.#connectionEpoch;
    this.#disposeConnection(false);
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#bootstrap = bootstrap;
    this.#rebuildPeerConnection(bootstrap, generation, connectionEpoch);
    this.#replacementCause = cause;
    this.#retiredLocalConnection = null;
    this.#negotiatedGeneration = null;
    for (const state of this.#localTracks.values()) {
      state.transceiver = null;
      state.enabled = false;
      state.providerPublicationId = null;
    }
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
  #rebuildPeerConnection(bootstrap: CloudflareSFUBootstrap, generation: number, connectionEpoch: number): void {
    try {
      this.#connection = this.#createPeerConnection(bootstrap);
      this.#observeConnection(this.#connection, generation, connectionEpoch);
    } catch (error) {
      this.#setFailure(error, "media_failed");
      throw error;
    }
  }
  #disposeConnection(stopSenders: boolean): void {
    this.#receiveProgress.replaced();
    if (!stopSenders) this.#setPhase("recovering", null);
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
  #removeOwnedLocalTrack(state: LocalTrackState, stopTrack = true): void {
    if (state.endedListener) state.track.removeEventListener("ended", state.endedListener);
    if (stopTrack) safeStopTrack(state.track, this.#reportError.bind(this));
    state.enabled = false;
    state.desiredEnabled = false;
    state.transceiver = null;
    state.providerPublicationId = null;
    state.endedListener = null;
  }
  #clearRemoteTracks(): void {
    for (const publication of this.#remoteTracks.values()) safeStopTrack(publication.track, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    this.#publishSnapshot();
    this.#emitRemote();
  }
  #schedulePoll(delayMs = this.#pollIntervalMs): void {
    if (this.#stopped || (!this.#started && !this.#receivingInitial) || this.#pollTimer !== undefined) return;
    this.#pollTimer = globalThis.setTimeout(async () => {
      this.#pollTimer = undefined;
      // Skip the network round-trip while the tab is hidden; the poll
      // reschedules itself and resumes on the next tick after visibility.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.#schedulePoll();
        return;
      }
      let nextDelay = this.#pollIntervalMs;
      try {
        await this.refreshRemotePublications();
        if (this.#remotePullIncomplete) nextDelay = this.#incompletePullDelay();
      } catch {
        // Keep the first retry prompt, then return toward the idle polling cadence.
        if (this.#pollFailedPull && this.#remotePullIncomplete) nextDelay = this.#incompletePullDelay();
        else {
          this.#pollFailures = Math.min(this.#pollFailures + 1, 6);
          nextDelay = Math.min(this.#pollIntervalMs, (500 + Math.random() * 500) * 2 ** (this.#pollFailures - 1));
        }
      } finally {
        this.#schedulePoll(nextDelay);
      }
    }, delayMs);
  }
  #incompletePullDelay(): number {
    this.#pollFailures = Math.min(this.#pollFailures + 1, 6);
    return Math.min(this.#pollIntervalMs, 750 * 2 ** (this.#pollFailures - 1));
  }
  #clearPoll(): void {
    this.#pollFailures = 0;
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
      receiveStalls: this.#receiveProgress.observations,
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
    this.#publishSnapshot("failed", { code, recoverable: code !== "invalid_bootstrap" && code !== "invalid_target" && code !== "invalid_publication", diagnostic: classifyMediaFailure(error, "peer_connection") });
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
    const owner = error instanceof Error ? this.#failureOwners.get(error) : undefined;
    if (owner && (owner.generation !== this.#generation || owner.connectionId !== this.#bootstrap.connectionId)) return;
    try {
      this.#onError?.(error, owner?.connectionId ?? this.#bootstrap.connectionId);
    } catch {
      // Consumer callbacks cannot prevent SFU cleanup or state reconciliation.
    }
  }
  async #signal<T>(operation: () => Promise<T>, owner = { generation: this.#generation, connectionId: this.#bootstrap.connectionId }): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error) this.#failureOwners.set(error, owner);
      throw error;
    }
  }
  #requireGeneration(generation: number): void {
    if (generation !== this.#generation || this.#stopped) throw new CloudflareSFUError("Stale media connection", "stale_generation");
  }
  #requireActive(): void {
    if (this.#stopped) throw new CloudflareSFUError("SFU client stopped", "media_failed");
  }
  #requireTransport(): CloudflareSFUSignalingTransport {
    if (!this.#transport) throw new CloudflareSFUError("SFU signaling unavailable", "signaling_failed");
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
function validateTrackSource(source: MediaPublicationSource, track: MediaStreamTrack): void {
  const valid = source === "microphone" || source === "screen_audio" ? track.kind === "audio" : track.kind === "video";
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
function observeConnectionState(
  peerState: RTCPeerConnectionState,
  iceState: RTCIceConnectionState,
  started: boolean,
):
  | (Pick<CloudflareSFUSnapshot, "failure"> & {
      readonly phase: CloudflareSFUSnapshot["connection"]["phase"];
    })
  | null {
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
  return (
    (left.receiveStalls ?? EMPTY_RECEIVE_STALLS) === (right.receiveStalls ?? EMPTY_RECEIVE_STALLS) &&
    connectionEqual(left.connection, right.connection) &&
    cursorEqual(left.cursor, right.cursor) &&
    failureEqual(left.failure, right.failure) &&
    left.localTracks.length === right.localTracks.length &&
    left.remoteTracks.length === right.remoteTracks.length
  );
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
async function createLocalOffer(connection: RTCPeerConnection) {
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  return requireDescription(offer);
}
function localSourceGroup(source: MediaPublicationSource): readonly MediaPublicationSource[] {
  return source === "screen" ? [source, "screen_audio"] : [source];
}
function isRateLimited(error: unknown): boolean {
  return error instanceof CloudflareSFUError && error.options.status === 429;
}
function retryableRemotePull(error: unknown): boolean {
  if (!(error instanceof CloudflareSFUError)) return false;
  if (error.code === "signaling_failed") return error.options.retryableConnection === true || error.options.status === 429;
  return ["signaling_timeout", "media_failed", "negotiation_timeout"].includes(error.code);
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
