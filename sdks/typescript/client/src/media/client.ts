import type { ClientMediaPlane, LocalPublicationRetirementCause, MediaConnectionReplacementCause, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaPublicationSource } from "./plane";
import type { TransportDiagnostic } from "../transport-diagnostics";
import { validateBootstrap, validateClientOptions, validateTrackSource } from "./client-validation";
import { ReceiveStallRecovery } from "./receive-stall";
import { AudioReceiveHealth } from "./audio-receive-health";
import { CameraUplinkPolicy, cameraUplinkBitrate } from "./camera-uplink";
import { ViewerLayerSelector, type ViewerLayerChange } from "./viewer-layer";
import { UNREPORTED_TILE_WAIT_MS, VideoTileSubscriptions } from "./video-tile-visibility";
import { resolveMediaTarget } from "./target";
import { comparePublicationCursor, parseSFUPublicationID, publicationKey, requireDescription, requireSFUDescription, validatePublicationSnapshot, waitFor } from "./tracks";
import { chunks, desiredRemotePublications, droppedRemoteTracks, matchRemotePullTracks, publicationsByTrack, reconcileRemoteTracks, trackKey } from "./remote-track-response";
import { freezeSnapshot, snapshotEqual } from "./snapshot";
import { failuresOf, isGoneStatus, isRateLimited, mediaTargetFailure, simulcastUnsupported } from "./failure-policy";
import { addLocalTransceiver } from "./local-transceiver";
import { retryableRemotePull } from "./remote-pull-scheduler";
import { LocalPublicationLedger, type LocalPublicationHandle, type LocalTrackState, type OwnedLocalPublication } from "./local-publications";
import { LocalRecoveryScheduler, type LocalRecovery } from "./local-recovery";
import { RemotePullScheduler } from "./remote-pull-scheduler";
import { PollScheduler } from "./poll-scheduler";
import { MediaConnectionReplacer, rejectedOnDeadConnection, retryableConnectionFailure } from "./connection-replacement";
import { IceRestartController } from "./ice-restart";
import {
  CAPTURE_REUSE_WINDOW_MS,
  CONNECTION_TIMEOUT_MS,
  DEAD_CONNECTION_REPLACEMENT_DELAYS_MS,
  EMPTY_LOCAL,
  EMPTY_REMOTE,
  ICE_DISCONNECTED_RESTART_MS,
  INVALID_PUBLICATION_SIGNATURE,
  isVideoPublication,
  localSourceGroup,
  NEGOTIATION_TIMEOUT_MS,
  NO_CAPABILITIES,
  OFFER_REPLACEMENT_COOLDOWN_MS,
  OFFER_SIZE_LIMIT_BYTES,
  PEER_OPERATION_TIMEOUT_MS,
  RECEIVER_RETIREMENT_ATTEMPTS,
  RECEIVER_RETIREMENT_LIMIT,
  type RemoteTrackEntry,
  TRACKS_PER_REQUEST,
  VIEWER_LAYER_BATCH_SIZE,
  VIEWER_LAYER_UPDATE_INTERVAL_MS,
} from "./sfu-limits";
import { PAGE_VISIBILITY_EVENTS, activeOfferedMids, bundleTagOf, connectionIsClosed, connectionIsLive, createLocalOffer, observeConnectionState, pageIsHidden, pictureInPictureTracks, requireTransceiverMid, safeStopTrack, safeStopTransceiver, transceiverOf, waitForConnectionLive, withDeadline } from "./peer-connection";
import { createCallStatsCollector, type CallStatsCollector } from "./call-stats";
import { SubscriptionDelivery, type DeliveredVideo } from "./subscription-delivery";
import { SFUError } from "./types";
import { iceServersFor } from "./ice-servers";
import { classifyMediaFailure, pullShortfall, subscribeFailure } from "./failure-diagnostics";
import { observeOperation } from "../telemetry/operation";
import type { SFUBootstrap, SFUClientOptions, SFUFailureCode, SFULocalOfferDiagnostic, SFUPublication, SFUPublicationSnapshot, SFURemoteTrack, SFURestartOptions, SFUSignalingTransport, SFUSnapshot, SFUTrackRequest, SFUTracksResponse, SFUMediaCapabilities } from "./types";
import type { PublicationCursor } from "./tracks";
import { expectedOfferAddition, measureOffer, shouldReplaceForOfferSize } from "./offer-size";
export class SFUClient implements ClientMediaPlane {
  readonly #localListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #onError: SFUClientOptions["onError"];
  readonly #telemetry: SFUClientOptions["telemetry"];
  readonly #onDiagnostic: SFUClientOptions["onDiagnostic"];
  readonly #onReceiveHealth: SFUClientOptions["onReceiveHealth"];
  readonly #onRemoteTrack: ((publication: SFURemoteTrack) => void) | undefined;
  readonly #onScreenEnded: (() => void) | undefined;
  readonly #participantId: string;
  readonly #peerConnectionFactory: ((configuration: RTCConfiguration) => RTCPeerConnection) | undefined;
  readonly #pollIntervalMs: number;
  readonly #cameraSimulcast: boolean;
  readonly #replaceMediaConnection: ((observedConnectionId: string) => Promise<SFUBootstrap>) | undefined;
  readonly #remoteListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #snapshotListeners = new Set<() => void>();
  readonly #failureOwners = new WeakMap<Error, { readonly generation: number; readonly connectionId: string }>();
  readonly #locals = new LocalPublicationLedger({
    serialize: (operation, retirement) => this.#serializeSDP(operation, retirement),
    closePublication: (publication) => this.#closeOwnedPublication(publication),
    stopped: () => this.#stopped,
    drained: () => {
      this.#transport = undefined;
    },
  });
  readonly #recovery = new LocalRecoveryScheduler({
    stopped: () => this.#stopped,
    paused: (source) => this.#locals.paused.has(source),
    stateOf: (source) => this.#locals.tracks.get(source),
    run: (source) => void this.#runLocalRecovery(source),
  });
  readonly #pulls = new RemotePullScheduler();
  readonly #poll = new PollScheduler({
    intervalMs: () => this.#pollIntervalMs,
    canPoll: () => !this.#stopped && (this.#started || this.#receivingInitial),
    hidden: () => pageIsHidden(),
    run: () => this.refreshRemotePublications(),
    pullIncomplete: () => this.#pulls.incomplete,
    heldTrackOff: () => this.#heldTrackSyncShowsOff(),
  });
  readonly #replacer = new MediaConnectionReplacer({
    requestReplacement: () => this.#replaceMediaConnection,
    observedConnectionId: () => this.#bootstrap.connectionId,
    generation: () => this.#generation,
    stopped: () => this.#stopped,
    started: () => this.#started,
    negotiatedGeneration: () => this.#negotiatedGeneration,
    keepsIdleSession: () => this.#capabilities().keepsIdleSession,
    connection: () => this.#connection,
    sdpPending: () => this.#sdpPending,
    requireGeneration: (generation) => this.#requireGeneration(generation),
    serializeSDP: (operation) => this.#serializeSDP(operation),
    adopt: (bootstrap, cause) => this.#adoptReplacement(bootstrap, cause),
    republish: (generation) => this.#republishPreparedTracksAfterRecovery(generation),
    reportError: (error) => this.#reportError(error),
  });
  readonly #ice = new IceRestartController({
    restartsInPlace: () => this.#restartsIceInPlace(),
    needsReceiveTransport: (generation) => this.#capabilities().iceRestart && this.#negotiatedGeneration !== generation,
    markNegotiated: (generation) => {
      this.#negotiatedGeneration = generation;
    },
    currentFailure: () => this.#snapshot.failure,
    generation: () => this.#generation,
    connectionEpoch: () => this.#connectionEpoch,
    connection: () => this.#connection,
    bootstrapConnectionId: () => this.#bootstrap.connectionId,
    stopped: () => this.#stopped,
    serializeSDP: (operation) => this.#serializeSDP(operation),
    createLocalOffer: (connection, origin) => this.#createLocalOffer(connection, origin, origin === "ice_restart" ? { iceRestart: true } : undefined),
    addTracks: (input, owner) => this.#signal(() => this.#addTracks(input), owner),
    applyProviderDescription: (response, connection, owner) => this.#applyProviderDescription(response, connection, owner),
    rollbackLocalOffer: (connection) => this.#rollbackLocalOffer(connection),
    reportHealth: (event) => this.#reportHealth(event),
    setFailure: (error, fallback) => this.#setFailure(error, fallback),
  });
  readonly #remoteTracks = new Map<string, SFURemoteTrack>();
  #bootstrap: SFUBootstrap;
  #connection: RTCPeerConnection;
  #disposeConnectionObservation: (() => void) | undefined;
  #connectionEpoch = 0;
  #cursor: PublicationCursor | null = null;
  readonly #receiveProgress = new ReceiveStallRecovery();
  readonly #receiveHealth: AudioReceiveHealth;
  readonly #viewerLayerPending = new Map<string, ViewerLayerChange>();
  readonly #delivery = new SubscriptionDelivery();
  // Off-screen videos this client paused in place. They keep their receiver, MID and track.
  readonly #viewerPaused = new Set<string>();
  // Advertised videos the tile policy leaves out of the last poll: hidden, off screen or in a hidden page.
  #hiddenVideos = 0;
  // Dropped remote tracks whose receive m-line is not closed yet, with the failed closes so far.
  readonly #unretiredReceivers = new Map<SFURemoteTrack, number>();
  // A stopped transceiver keeps its mid until the next negotiation, so a later retirement would find it and close it a second time.
  readonly #closedReceiverTracks = new WeakSet<MediaStreamTrack>();
  // Layer and pause updates reach the SFU in the order the client decided them, so a layer update cannot resume a pause.
  #trackUpdates: Promise<unknown> = Promise.resolve();
  #viewerLayerUpdating = false;
  #viewerLayerUpdateAt = Number.NEGATIVE_INFINITY;
  #syncPublications: readonly MediaPublication[] = [];
  readonly #videoTiles: VideoTileSubscriptions;
  readonly #stopObservingVideoTiles: () => void;
  #videoTileWake: ReturnType<typeof globalThis.setTimeout> | undefined;
  #generation = 0;
  #negotiatedGeneration: number | null = null;
  #offerBudgetCooldownUntil = 0;
  #sdpTail: Promise<void> = Promise.resolve();
  #sdpPending = 0;
  // The SDK call that started the pending local offer. Null once an answer or a rollback ends it.
  #localOffer: { readonly connection: RTCPeerConnection; readonly origin: LocalOfferOrigin; readonly at: number } | null = null;
  #snapshot: SFUSnapshot;
  #started = false;
  // The epoch of the last connection that went live; a pull that times out on any other one never connected.
  #connectedEpoch = -1;
  #receivingInitial = false;
  #stopped = false;
  #transport: SFUSignalingTransport | undefined;
  readonly #callStats: CallStatsCollector;
  constructor(options: SFUClientOptions) {
    validateClientOptions(options);
    this.#participantId = options.participantId;
    this.#bootstrap = options.bootstrap;
    this.#transport = options.transport;
    this.#pollIntervalMs = options.pollIntervalMs ?? 15000;
    this.#cameraSimulcast = options.cameraSimulcast ?? true;
    this.#videoTiles = new VideoTileSubscriptions(pageIsHidden(), Date.now(), options.unreportedVideoTileWaitMs ?? UNREPORTED_TILE_WAIT_MS);
    this.#replaceMediaConnection = options.replaceMediaConnection;
    this.#onError = options.onError;
    this.#telemetry = options.telemetry;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onReceiveHealth = options.onReceiveHealth;
    this.#callStats = createCallStatsCollector({ record: (draft) => options.telemetry?.record(draft), interruption: (withinMs) => options.telemetry?.interruption(withinMs) ?? null });
    this.#onRemoteTrack = options.onRemoteTrack;
    this.#onScreenEnded = options.onScreenEnded;
    this.#peerConnectionFactory = options.peerConnectionFactory;
    this.#connection = this.#createPeerConnection(options.bootstrap);
    this.#receiveHealth = new AudioReceiveHealth({
      now: () => Date.now(),
      setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
      clearInterval: (timer) => globalThis.clearInterval(timer),
      connection: () => this.#connection,
      tracks: () => this.#remoteTracks.values(),
      onEvent: (event) => this.#invokeListener(() => this.#onReceiveHealth?.(event)),
    });
    this.#snapshot = freezeSnapshot({
      connection: { phase: "idle", peerConnectionState: this.#connection.connectionState, iceConnectionState: this.#connection.iceConnectionState },
      cursor: null,
      localTracks: EMPTY_LOCAL,
      remoteTracks: EMPTY_REMOTE,
      receiveStalls: this.#receiveProgress.observations,
      failure: null,
    });
    this.#observeConnection(this.#connection, this.#generation, this.#connectionEpoch);
    this.#stopObservingVideoTiles = this.#observeVideoTiles();
  }
  getSnapshot(): SFUSnapshot {
    return this.#snapshot;
  }
  subscribe(listener: () => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => {
      this.#snapshotListeners.delete(listener);
    };
  }
  remotePublicationResumed(publicationId: string): void {
    this.#pulls.forget(publicationId);
    this.remotePublicationsChanged();
  }
  localPublicationWithdrawn(publicationId: string): void {
    const owned = [...this.#locals.owned].find((publication) => publication.lifecycle.kind === "confirmed" && publication.lifecycle.handle.publicationId === publicationId && publication.state.providerPublicationId === publicationId);
    const state = owned?.state;
    if (!state || !state.desiredEnabled || this.#locals.tracks.get(state.source) !== state) return;
    this.#recovery.begin(state, publicationId, false);
  }
  remoteParticipantsChanged(participantIds: readonly string[]): void {
    this.#pulls.setRemoteParticipants(participantIds);
    this.#pulls.noteInputChanged();
    this.remotePublicationsChanged();
  }
  remotePublicationsChanged(publications?: readonly MediaPublication[], projectionState: "available" | "unavailable" = "available"): void {
    if (projectionState === "unavailable") this.#syncPublications = [];
    else if (publications) this.#syncPublications = publications;
    if (projectionState === "unavailable") this.#receiveHealth.projection([]);
    else if (publications) this.#receiveHealth.projection(publications);
    if (projectionState === "unavailable") this.#receiveProgress.suspend();
    else if (publications) this.#receiveProgress.expect(publications, this.#participantId);
    this.#poll.repoll();
  }
  prepareLocalTrack(source: MediaPublicationSource, track: MediaStreamTrack): void {
    this.#requireActive();
    validateTrackSource(source, track);
    if (this.#locals.tracks.has(source)) throw new SFUError(`A ${source} track is already prepared`, "media_failed");
    const reusable = [...this.#locals.owned].find((item) => item.state.source === source && item.connection === this.#connection && (item.lifecycle.kind === "confirmed" || item.lifecycle.kind === "held"));
    const state: LocalTrackState = {
      source,
      track,
      transceiver: reusable?.transceiver ?? null,
      providerPublicationId: reusable && (reusable.lifecycle.kind === "confirmed" || reusable.lifecycle.kind === "held") ? reusable.lifecycle.handle.publicationId : null,
      desiredEnabled: false,
      enabled: false,
      endedListener: null,
      clearing: null,
    };
    if (source === "screen") {
      state.endedListener = () => {
        if (this.#locals.tracks.get("screen") === state) this.#invokeListener(() => this.#onScreenEnded?.());
      };
      track.addEventListener("ended", state.endedListener);
    }
    this.#recovery.drop(source);
    this.#locals.tracks.set(source, state);
    this.#publishSnapshot();
    this.#emitLocal();
  }
  async clearPreparedLocalTrack(source: MediaPublicationSource, options: { readonly stopTrack?: boolean } = {}): Promise<void> {
    this.#recovery.drop(source);
    const state = this.#locals.tracks.get(source);
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
    this.#recovery.drop(source);
    if (source === "screen" || source === "screen_audio") {
      try {
        this.#pauseLocalSource(source, "capture_cleanup");
        await this.#retireOwnedPublications();
      } finally {
        this.#locals.removeTrack(state, this.#reportError.bind(this), stopTrack);
        if (this.#locals.tracks.get(source) === state) this.#locals.tracks.delete(source);
        this.#publishSnapshot();
        this.#emitLocal();
      }
      return;
    }
    if (state.enabled) await this.#disablePreparedTrack(state);
    if (this.#locals.tracks.get(source) !== state) return;
    this.#locals.removeTrack(state, this.#reportError.bind(this), stopTrack);
    this.#locals.tracks.delete(source);
    this.#publishSnapshot();
    this.#emitLocal();
  }
  async start(localMedia: MediaStream, beforePublish?: () => Promise<MediaStream>): Promise<void> {
    if (this.#started) return;
    this.#requireActive();
    this.#receiveHealth.start();
    const generation = this.#generation;
    this.#publishSnapshot("connecting", null);
    if (beforePublish) {
      this.#receivingInitial = true;
      this.#poll.wake(0);
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
      [...this.#locals.tracks.values()].filter((state) => state.source === "microphone" || state.source === "camera"),
      generation,
    );
  }

  async refreshRemotePublications(): Promise<void> {
    if (!this.#poll.tryBeginRefresh()) return;
    const generation = this.#generation;
    try {
      const transport = this.#requireTransport();
      await this.#pullSyncAdvertisedPublications(generation);
      const authoritative = await this.#listOrPullPublications(transport, generation);
      this.#requireGeneration(generation);
      this.#republishUnlistedLocalPublications(authoritative);
      await this.#reconcileRemotePublications(authoritative, generation);
      this.#requireGeneration(generation);
      if (!this.#pulls.incomplete) this.#poll.noteSucceeded();
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#reportError(error);
      throw error;
    } finally {
      this.#finishPublicationPoll(generation);
    }
  }
  async #listOrPullPublications(transport: SFUSignalingTransport, generation: number): Promise<SFUPublicationSnapshot> {
    const pull = transport.pullPublishedAudio?.bind(transport);
    if (!pull || !this.#capabilities().pullPublished || this.#pulls.pullPublishedTried || this.#cursor !== null || this.#remoteTracks.size > 0) {
      return this.#signal(() => transport.listPublications());
    }
    this.#pulls.pullPublishedTried = true;
    try {
      return await observeOperation(this.#telemetry, { action: "subscribe" }, () => this.#pullPublishedAudio(pull, generation), subscribeFailure);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      // The combined request is an optimisation. After a failure, list and pull the old way, so the reconcile
      // owns every recovery (a gone connection, a retryable pull) exactly as it does for a later poll.
      return this.#signal(() => transport.listPublications());
    }
  }
  // A Sync media item already names the publication, and a publication ID carries the session and track a pull needs, so a
  // new one is pulled before the registry listing confirms it. The listing that follows stays the authority: it prunes,
  // recovers and retries. A failed early pull only leaves the publication to that listing.
  async #pullSyncAdvertisedPublications(generation: number): Promise<void> {
    const pending = await this.#pendingSyncAdvertisedPulls();
    if (pending.length === 0) return;
    const epoch = this.#connectionEpoch;
    let pulled: readonly SFURemoteTrack[] | null;
    try {
      pulled = await this.#pull(pending, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      // The listing owns retry and recovery; do not let this attempt's backoff delay it.
      for (const publication of pending) this.#pulls.forget(publication.publicationId);
      return;
    }
    this.#requireGeneration(generation);
    if (pulled === null) return;
    if (epoch !== this.#connectionEpoch) {
      for (const publication of pulled) safeStopTrack(publication.track, this.#reportError.bind(this));
      return;
    }
    this.#commitEarlyPulledTracks(pulled);
  }
  async #pendingSyncAdvertisedPulls(): Promise<SFUPublication[]> {
    if (!this.#started || !this.#capabilities().subscriptionState) return [];
    const named = this.#syncPublications.flatMap(({ participantId, source, enabled, publicationId }) => (enabled && publicationId !== null ? [{ participantId, source, publicationId }] : []));
    const advertised = desiredRemotePublications(
      named.filter((publication) => this.#pulls.canSubscribe(publication)),
      this.#participantId,
    );
    const fresh = new Map([...this.#visibleRemotePublications(advertised)].filter(([key, publication]) => this.#remoteTracks.get(key)?.publicationId !== publication.publicationId));
    const pending = this.#pulls.pending(fresh, this.#remoteTracks, this.#receiveProgress, this.#replaceMediaConnection !== undefined);
    // The listing that follows owns the replacement (#pullWithRecovery); an early pull would only add a section to an offer that is already too large.
    return pending.length > 0 && (await this.#hasSpentOfferBudget(pending, false, false)) ? [] : pending;
  }
  #commitEarlyPulledTracks(pulled: readonly SFURemoteTrack[]): void {
    const next = new Map(this.#remoteTracks);
    for (const publication of pulled) next.set(publicationKey(publication), publication);
    const dropped = droppedRemoteTracks(this.#remoteTracks, next);
    this.#remoteTracks.clear();
    for (const [key, publication] of next) this.#remoteTracks.set(key, publication);
    this.#announcePulledTracks(pulled);
    // The listing that follows retires them, as it does for a reconcile.
    this.#queueDroppedReceivers(dropped);
  }
  // The registry drops a publication when listeners keep failing to pull it.
  // A publisher that still believes it is sending must publish again, so
  // listeners get a new publication ID instead of retrying a dead one.
  #republishUnlistedLocalPublications(authoritative: SFUPublicationSnapshot): void {
    const unlisted = [...this.#locals.tracks.values()].filter((state) => state.enabled && state.desiredEnabled && state.providerPublicationId !== null && !authoritative.publications.some((publication) => publication.publicationId === state.providerPublicationId));
    for (const state of unlisted) this.#recovery.begin(state, state.providerPublicationId, true);
  }
  async #runLocalRecovery(source: MediaPublicationSource): Promise<void> {
    const recovery = this.#recovery.get(source);
    if (!recovery || recovery.running || this.#recovery.discard(recovery)) return;
    recovery.running = true;
    try {
      await this.#attemptLocalRecovery(recovery);
    } catch (error) {
      await this.#retryLocalRecovery(recovery, error);
    } finally {
      recovery.running = false;
    }
  }
  async #attemptLocalRecovery(recovery: LocalRecovery): Promise<void> {
    if (!(await this.#relistLocalRecoveryIfNeeded(recovery)) || !this.#recovery.canContinue(recovery)) {
      this.#recovery.drop(recovery.state.source, recovery);
      return;
    }
    this.#retireDeadLocalPublication(recovery);
    if (await this.#retireLocalRecoveryIfNeeded(recovery)) return;
    const published = await this.#enablePreparedTrack(recovery.state);
    if (this.#recovery.discard(recovery)) return;
    if (!this.#recovery.settle(recovery, published)) this.#recovery.retry(recovery);
  }
  async #relistLocalRecoveryIfNeeded(recovery: LocalRecovery): Promise<boolean> {
    const { state, deadPublicationId } = recovery;
    if (!recovery.relist || deadPublicationId === null) return true;
    const authoritative = await this.#signal(() => this.#requireTransport().listPublications());
    if (!this.#recovery.canRecover(recovery) || state.providerPublicationId !== deadPublicationId || !state.desiredEnabled) return false;
    if (authoritative.publications.some((publication) => publication.publicationId === deadPublicationId)) {
      this.#recovery.drop(state.source, recovery);
      return false;
    }
    recovery.relist = false;
    return true;
  }
  #retireDeadLocalPublication(recovery: LocalRecovery): void {
    if (recovery.retiring || recovery.deadPublicationId === null || recovery.state.providerPublicationId !== recovery.deadPublicationId) return;
    recovery.retiring = true;
    this.#pauseLocalSource(recovery.state.source, "discovery_absent", { group: false });
  }
  async #retireLocalRecoveryIfNeeded(recovery: LocalRecovery): Promise<boolean> {
    if (!this.#locals.hasRetiring(recovery.state.source)) return false;
    await this.#retireLocalRecoveryPublications(recovery.state.source);
    return this.#recovery.discard(recovery);
  }
  async #retryLocalRecovery(recovery: LocalRecovery, error: unknown): Promise<void> {
    if (this.#recovery.discard(recovery)) return;
    this.#reportLocalRecoveryError(error);
    await this.#replaceConnectionForLocalRecovery(error);
    this.#recovery.retry(recovery);
  }
  #reportLocalRecoveryError(error: unknown): void {
    for (const cause of failuresOf(error)) this.#reportError(cause);
  }
  async #replaceConnectionForLocalRecovery(error: unknown): Promise<void> {
    const failures = failuresOf(error);
    if (!this.#replaceMediaConnection || failures.length === 0 || !failures.every((failure) => retryableConnectionFailure(failure))) return;
    const generation = this.#generation;
    try {
      await this.#replacer.replace(generation, "local_signaling_failure");
    } catch {
      return;
    }
    try {
      await this.#republishPreparedTracksAfterRecovery(generation);
    } catch (republishError) {
      this.#reportLocalRecoveryError(republishError);
    }
  }
  #retireLocalRecoveryPublications(source: MediaPublicationSource): Promise<void> {
    return this.#retireOwnedPublications(() => {}, [source]);
  }
  #finishPublicationPoll(generation: number): void {
    if (generation !== this.#generation) return;
    this.#poll.finishRefresh();
  }
  /**
   * Runs what an enable can do while Sync still decides it, so the grant does not wait behind that round trip.
   * A parked microphone (mute in place) is resumed on the SFU at once; no other source goes ahead, so a camera
   * unmute waits for the result. The node's source lease authorizes what the microphone forwards: a closed lease
   * forwards nothing, and a role change, a removal and the end of the Episode revoke it.
   * Until Sync's first result, the resumed microphone may forward under a standing lease; the caller then either runs
   * `setLocalPublicationTarget` or undoes the resume with `cancelPreparedLocalPublicationTarget`. Otherwise this
   * swaps a connection that never carried media for a fresh one, adds no transceiver and sends no offer. A fresh
   * publish never goes ahead, because a new publication needs the grant. `setLocalPublicationTarget` redoes
   * whatever this left undone, so a rejection is safe to ignore.
   */
  async prepareLocalPublicationTarget(target: MediaPlaneTarget): Promise<void> {
    if (!target.enabled || this.#locals.paused.has(target.source)) return;
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#locals.tracks, target);
    if (resolved.kind !== "state") return;
    if (target.source === "microphone" && this.#locals.held(target.source, this.#connection) && !this.#replacer.pending) {
      const head = { cancelled: false };
      this.#locals.headStartCancelled.set(target.operationId, head);
      return this.#locals
        .enqueueHeadStart(target.source, () => this.#resumeHeldAheadOfGrant(resolved.value, head))
        .finally(() => {
          if (this.#locals.headStartCancelled.get(target.operationId) === head) this.#locals.headStartCancelled.delete(target.operationId);
        });
    }
    await this.#replaceDormantConnectionAhead();
  }
  async #replaceDormantConnectionAhead(): Promise<void> {
    const generation = this.#generation;
    const attemptedBefore = this.#replacer.attemptedGeneration === generation;
    try {
      await this.#serializeSDP(async () => {
        // A retired bundled sender rebuilds the connection and republishes other sources inside the publish itself.
        if (this.#locals.retiredConnection === this.#connection && this.#replaceMediaConnection) return;
        await this.#replacer.replaceDormantBeforeNegotiation(generation);
      });
    } catch (error) {
      // The grant-gated publish owns the replacement now, so its own attempt must still run and report.
      if (!attemptedBefore && this.#replacer.attemptedGeneration === generation) this.#replacer.attemptedGeneration = null;
      throw error;
    }
  }
  /**
   * Silences what `prepareLocalPublicationTarget` resumed, and parks it again the way a user mute does. The sender goes quiet
   * at once and locally (the track is disabled; no request, so a lost response cannot delay it), and a queued head start of the
   * same operation never starts. The SFU hold follows once any resume request has settled, whether or not it was acknowledged,
   * because a lost response may still have reached the node. It does nothing when nothing was resumed ahead, or when the enable
   * has already taken the publication over: that enable owns its own failure.
   */
  cancelPreparedLocalPublicationTarget(target: MediaPlaneTarget): Promise<void> {
    const head = this.#locals.headStartCancelled.get(target.operationId);
    if (head) head.cancelled = true;
    const publication = this.#locals.resumedAhead.get(target.source);
    if (!publication) return Promise.resolve();
    const state = this.#locals.tracks.get(target.source);
    if (state && !state.desiredEnabled) state.track.enabled = false;
    return this.#locals.enqueueHeadStart(target.source, () => this.#parkResumedAhead(target.source, publication));
  }
  async #parkResumedAhead(source: MediaPublicationSource, publication: OwnedLocalPublication): Promise<void> {
    if (this.#locals.resumedAhead.get(source) !== publication) return;
    this.#locals.resumedAhead.delete(source);
    const { state } = publication;
    if (state.desiredEnabled) return;
    state.track.enabled = false;
    // A resume that failed or got no answer may still have reached the node, so the publication is parked as a resumed one.
    if (publication.lifecycle.kind === "held") publication.lifecycle = { kind: "confirmed", handle: publication.lifecycle.handle };
    if (publication.lifecycle.kind !== "confirmed") return;
    this.#locals.markRetiring(publication, "user_pause");
    await this.#retireOwnedPublications(undefined, [source]);
  }
  async setLocalPublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    if (!target.enabled) return this.#pausePublicationTarget(target);
    await this.#locals.headStarts.get(target.source);
    const result = await this.#enablePublicationTarget(target).finally(() => this.#locals.resumedAhead.delete(target.source));
    if (target.source !== "screen" || !this.#locals.tracks.has("screen_audio") || (result.outcome !== "confirmed" && result.outcome !== "satisfied")) return result;
    return this.#enablePublicationTarget({ ...target, source: "screen_audio" });
  }
  async #pausePublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    this.#recovery.drop(target.source);
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#locals.tracks, target);
    if (resolved.kind === "result" && resolved.result.outcome !== "satisfied") return resolved.result;
    const outcome = resolved.kind === "state" && resolved.value.enabled ? "confirmed" : "satisfied";
    this.#recovery.drop(target.source);
    if (target.source !== "screen" && this.#locals.paused.get(target.source) === "capture_cleanup") {
      // Sync acknowledges unavailable capture without revoking its retained
      // publication. Explicit Off first records user_pause and still retires.
      await this.pauseLocalCapture(target.source);
      return { outcome, errorCode: null };
    }
    // Sync's off acknowledgment reaches a publication the user's mute already parked; closing it would undo the park.
    if (this.#locals.held(target.source, this.#connection)) return { outcome, errorCode: null };
    this.#pauseLocalSource(target.source);
    try {
      await this.#retireOwnedPublications();
      return { outcome, errorCode: null };
    } catch (error) {
      return mediaTargetFailure(error);
    }
  }
  async #waitForReplacementBeforeEnable(state: LocalTrackState, generation: number, replacement: { readonly generation: number; readonly promise: Promise<void> } | null): Promise<MediaPlaneResult | null> {
    if (replacement?.generation !== generation) return null;
    state.desiredEnabled = true;
    await replacement.promise.catch(() => {});
    if (this.#locals.paused.has(state.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    if (!state.desiredEnabled) return { outcome: "satisfied", errorCode: null };
    state.track.enabled = true;
    return null;
  }
  #postReplacementEnableOutcome(state: LocalTrackState, generation: number, replacement: { readonly generation: number; readonly promise: Promise<void> } | null): MediaPlaneResult | null {
    if (this.#locals.paused.has(state.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    if (replacement?.generation === generation && !state.desiredEnabled) return { outcome: "satisfied", errorCode: null };
    if (state.enabled) {
      state.track.enabled = true;
      return { outcome: "satisfied", errorCode: null };
    }
    return null;
  }
  async #enablePublicationTarget(target: Omit<MediaPlaneTarget, "source"> & { readonly source: MediaPublicationSource }): Promise<MediaPlaneResult> {
    const generation = this.#generation;
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#locals.tracks, target);
    if (resolved.kind === "result") return resolved.result;
    const state = resolved.value;
    if (this.#locals.paused.has(target.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    try {
      const replacement = this.#replacer.pending;
      const replacementOutcome = await this.#waitForReplacementBeforeEnable(state, generation, replacement);
      if (replacementOutcome) return replacementOutcome;
      await this.#retireUnavailableLocalPublication(state);
      const postReplacementOutcome = this.#postReplacementEnableOutcome(state, generation, replacement);
      if (postReplacementOutcome) return postReplacementOutcome;
      if (!(await this.#enablePreparedTrack(state))) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
      return { outcome: "confirmed", errorCode: null };
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) this.#reportError(error);
      return mediaTargetFailure(error);
    }
  }
  async pauseLocalCapture(source: "microphone" | "camera"): Promise<void> {
    this.#recovery.drop(source);
    this.#locals.paused.set(source, "capture_cleanup");
    const state = this.#locals.tracks.get(source);
    if (state) await this.#disablePreparedTrack(state);
  }
  setLocalSourceIntent(source: MediaPublicationSource, enabled: boolean, cause: LocalPublicationRetirementCause = "forced_pause"): Promise<void> {
    const sources = localSourceGroup(source);
    if (!enabled) this.#recovery.drop(source);
    for (const item of sources) {
      if (enabled) this.#locals.paused.delete(item);
      else this.#locals.paused.set(item, cause);
    }
    if (!enabled) this.#pauseLocalSource(source, cause);
    return enabled ? Promise.resolve() : this.#retireOwnedPublications();
  }
  async closeForcedLocalPublication(source: MediaPublicationSource, cause: LocalPublicationRetirementCause = "forced_pause"): Promise<void> {
    const connection = this.#connection;
    const generationAtClose = this.#generation;
    const sources = localSourceGroup(source);
    const ownsPublication = [...this.#locals.owned].some((item) => sources.includes(item.state.source));
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
    if (this.#locals.retirement !== failedRetirement) await this.#locals.retirement;
  }
  #fenceFailedClose(error: unknown, connection: RTCPeerConnection, generation: number, cause: LocalPublicationRetirementCause): Promise<void> | undefined {
    const failures = failuresOf(error);
    if (!failures.every((failure) => retryableConnectionFailure(failure))) throw error;
    // A late failure belongs to its issued connection, never its replacement.
    if (connection !== this.#connection || generation !== this.#generation) return;
    // The sender is detached and the provider's SDP outcome is uncertain.
    // Recover through the same owner as successful bundled-sender retirement.
    this.#locals.retiredConnection = connection;
    this.#locals.retiredCause = cause;
    return this.#locals.retirement;
  }
  #restoreEnabledSourcesAfterClose(source: MediaPublicationSource): Promise<void> {
    const generation = this.#generation;
    return this.#serializeSDP(async () => {
      const existing = new Set([...this.#locals.tracks.values()].filter((state) => state.source !== source && state.providerPublicationId !== null));
      const states = await this.#prepareConnectionForPublication([], generation);
      await this.#publishPreparedTracksSerialized(
        states.filter((state) => existing.has(state)),
        generation,
        this.#connection,
        this.#bootstrap.connectionId,
      );
      this.#requireGeneration(generation);
      this.#publishSnapshot("live", null);
    });
  }
  async #retireUnavailableLocalPublication(state: LocalTrackState): Promise<void> {
    const publicationId = state.providerPublicationId;
    if (!publicationId) return;
    // The publication list leaves out a parked publication, so absence there is not loss.
    if ((this.#locals.held(state.source, this.#connection) ?? this.#locals.resumedAheadOf(state, this.#connection))?.handle.publicationId === publicationId) return;
    const authoritative = await this.#signal(() => this.#requireTransport().listPublications());
    if (authoritative.publications.some((publication) => publication.publicationId === publicationId)) return;
    if (state.providerPublicationId !== publicationId || this.#recovery.has(state.source)) return;
    if (state.enabled && state.desiredEnabled) {
      this.#recovery.begin(state, publicationId, true);
      return;
    }
    this.#pauseLocalSource(state.source, "discovery_absent");
    await this.#retireOwnedPublications();
  }
  #pauseLocalSource(source: MediaPublicationSource, cause: LocalPublicationRetirementCause = "forced_pause", options: { readonly group?: boolean } = {}): void {
    const sources = options.group === false ? [source] : localSourceGroup(source);
    for (const publication of this.#locals.owned) {
      if (!sources.includes(publication.state.source)) continue;
      this.#locals.markRetiring(publication, cause);
    }
    for (const state of this.#locals.tracks.values()) {
      if (!sources.includes(state.source)) continue;
      state.desiredEnabled = false;
      this.#locals.clearState(state);
    }
    this.#publishSnapshot();
    this.#emitLocal();
  }
  #retireOwnedPublications(reportFailure: (error: unknown) => void = this.#reportError.bind(this), sources?: readonly MediaPublicationSource[]): Promise<void> {
    return this.#locals.retireOwned(reportFailure, sources);
  }
  async #closeOwnedPublicationKeepingBundleTransport(publication: OwnedLocalPublication, phase: Extract<OwnedLocalPublication["lifecycle"], { kind: "retiring" }>, handle: LocalPublicationHandle): Promise<void> {
    if (!phase.detached && !connectionIsClosed(publication.connection)) {
      await this.#boundPeerOperation(publication.transceiver.sender.replaceTrack(null));
      if (!connectionIsClosed(publication.connection)) {
        // Keep the BUNDLE transport on forced close; renegotiation without its tag MID expires this SFU session (2026-10-30 probe).
        publication.transceiver.direction = "inactive";
      }
    }
    phase.detached = true;
    await this.#signal(
      () =>
        this.#requireTransport().closeTracks({
          connectionId: publication.connectionId,
          sessionDescription: undefined,
          tracks: [{ ...handle, source: publication.state.source }],
          force: true,
        }),
      { generation: this.#generation, connectionId: publication.connectionId },
    );
    publication.lifecycle = { kind: "retired" };
    this.#locals.owned.delete(publication);
  }
  // A user mute parks the track on the SFU and keeps its transceiver, so it moves no SDP and
  // the next unmute resumes it. False means the SFU refused the park; the caller then closes it.
  async #holdOwnedPublication(publication: OwnedLocalPublication, phase: Extract<OwnedLocalPublication["lifecycle"], { kind: "retiring" }>, handle: LocalPublicationHandle): Promise<boolean> {
    if (!phase.detached) {
      await this.#boundPeerOperation(publication.transceiver.sender.replaceTrack(null));
      phase.detached = true;
    }
    if (!(await this.#setLocalPublicationHeld(publication, handle, true))) return false;
    publication.lifecycle = { kind: "held", handle };
    publication.detachedAt = null;
    return true;
  }
  async #setLocalPublicationHeld(publication: OwnedLocalPublication, handle: LocalPublicationHandle, paused: boolean): Promise<boolean> {
    try {
      const response = await this.#updateTracks([{ location: "local", mid: handle.mid, trackName: publication.trackName, source: publication.state.source, publicationId: handle.publicationId, paused }]);
      return !response.trackErrors?.length;
    } catch {
      // A failed park or resume is recoverable: the caller closes or republishes through the normal path, which reports its own failure.
      return false;
    }
  }
  // A user mute leaves the SDP alone: parked on the SFU when it can hold, else closed over the kept BUNDLE transport.
  async #retireWithoutRenegotiation(publication: OwnedLocalPublication, phase: Extract<OwnedLocalPublication["lifecycle"], { kind: "retiring" }>, handle: LocalPublicationHandle): Promise<boolean> {
    if (
      this.#locals.canHoldOnUserPause(publication, phase, { muteInPlace: this.#capabilities().muteInPlace, updatesInPlace: this.#transport?.updateTracks !== undefined, connection: this.#connection, connectionId: this.#bootstrap.connectionId }) &&
      (await this.#holdOwnedPublication(publication, phase, handle))
    )
      return true;
    // The close offer carries every closed section. Past the size budget it could reach the node's cap, so close without SDP and let the next pull or publish replace the connection.
    const keep = this.#locals.keepBundleOnUserPause(publication, connectionIsClosed(publication.connection)) || (!connectionIsClosed(publication.connection) && shouldReplaceForOfferSize(await this.#measureLocalOffer(publication.connection)));
    if (keep) await this.#closeOwnedPublicationKeepingBundleTransport(publication, phase, handle);
    return keep;
  }
  async #closeOwnedPublication(publication: OwnedLocalPublication): Promise<void> {
    // A resume still in flight must reach the SFU before the close, or the close would be answered by the resume.
    await this.#locals.resumesInFlight.get(publication);
    const phase = publication.lifecycle;
    if (phase.kind !== "retiring" || !phase.handle) return;
    const handle = phase.handle;
    const { connection, connectionId, transceiver, state } = publication;
    try {
      if (await this.#retireWithoutRenegotiation(publication, phase, handle)) return;
      this.#locals.markBundledRetiring(publication);
      const withoutSdp = await this.#locals.detachForClose(publication, phase, () => this.#boundPeerOperation(transceiver.sender.replaceTrack(null)));
      const sessionDescription = withoutSdp ? undefined : await this.#createLocalOffer(connection, "close");
      const response = await this.#signal(() => this.#requireTransport().closeTracks({ connectionId, sessionDescription, tracks: [{ ...handle, source: state.source }], force: withoutSdp }), { generation: this.#generation, connectionId });
      // The API has committed the disabled observation even if applying SDP fails.
      publication.lifecycle = { kind: "retired" };
      this.#locals.owned.delete(publication);
      if (!withoutSdp || response.sessionDescription) await this.#applyProviderDescriptionIfOpen(response, connection, { generation: this.#generation, connectionId });
    } catch (error) {
      await this.#rollbackLocalOffer(connection);
      throw error;
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
  observeAudioElement(track: MediaStreamTrack, element: HTMLAudioElement): { played(result: unknown): void; detach(): void } {
    return this.#receiveHealth.observeAudioElement(track, element);
  }
  async restart(input: SFUBootstrap | SFURestartOptions): Promise<void> {
    this.#requireActive();
    const options: SFURestartOptions = "connectionId" in input ? { bootstrap: input } : input;
    validateBootstrap(options.bootstrap);
    if (options.bootstrap.connectionId !== this.#bootstrap.connectionId) {
      this.#locals.fence();
      this.#replacer.noteCause("access_refresh");
    }
    const generation = ++this.#generation;
    const connectionEpoch = ++this.#connectionEpoch;
    this.#poll.reset();
    this.#pulls.clearRetries();
    this.#publishSnapshot("recovering", null);
    this.#disposeConnection(false);
    for (const publication of this.#locals.owned) this.#locals.markRetiring(publication);
    void this.#retireOwnedPublications();
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#negotiatedGeneration = null;
    this.#replacer.attemptedGeneration = options.bootstrap.connectionId !== this.#bootstrap.connectionId ? generation : null;
    // Fresh access already replaced the expired SFU connection. Replacing it
    // again before its first offer adds a serial request and abandons that connection.
    if (options.bootstrap.connectionId !== this.#bootstrap.connectionId) this.#started = false;
    this.#bootstrap = options.bootstrap;
    if (options.transport) this.#transport = options.transport;
    this.#rebuildPeerConnection(options.bootstrap, generation, connectionEpoch);
    for (const state of this.#locals.tracks.values()) {
      state.transceiver = null;
      state.enabled = false;
    }
    const enabled = [...this.#locals.tracks.values()].filter((state) => state.desiredEnabled && state.track.readyState !== "ended");
    await this.#activatePreparedTracks(enabled, generation);
  }
  async #activatePreparedTracks(states: readonly LocalTrackState[], generation: number): Promise<void> {
    try {
      await this.#publishPreparedTracks(states, generation);
      await this.#ice.establishReceiveTransport(generation);
      this.#requireGeneration(generation);
      if (this.#pulls.recoveryGeneration !== generation) this.#replacer.attemptedGeneration = null;
      this.#started = true;
      this.#publishSnapshot("live", null);
      this.#poll.wake(0);
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
    this.#callStats.flush();
    this.#receiveHealth.roster([]);
    this.#receiveHealth.dispose();
    this.#receiveProgress.expect([], this.#participantId);
    this.#recovery.clear();
    this.#pulls.clear();
    this.#stopObservingVideoTiles();
    this.#generation++;
    this.#connectionEpoch++;
    this.#poll.reset();
    this.#disposeConnection(true);
    for (const publication of this.#locals.owned) this.#locals.markRetiring(publication);
    this.#clearRemoteTracks();
    for (const state of this.#locals.tracks.values()) {
      state.track.enabled = false;
      this.#locals.removeTrack(state, this.#reportError.bind(this));
    }
    this.#locals.tracks.clear();
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
      if (this.#locals.paused.has(state.source)) return false;
      state.desiredEnabled = true;
      state.track.enabled = true;
      this.#locals.adoptParked(state, this.#connection);
      if (state.providerPublicationId && state.transceiver) return await this.#reattachLocalTrack(state, state.transceiver);
      await this.#publishPreparedTracks([state], generation);
      // A completed local request restores the budget, except while a remote
      // recovery that spent it is still unresolved: restoring it then lets every
      // poll replace the healthy connection again for the same bad publication.
      if (this.#pulls.recoveryGeneration !== generation) this.#replacer.attemptedGeneration = null;
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
    const publication = [...this.#locals.owned].find((item) => item.transceiver === state.transceiver && item.lifecycle.kind === "confirmed");
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
      this.#locals.fence();
    }
  }
  #isExpiredRetiredConnection(error: unknown): boolean {
    if (!this.#replaceMediaConnection || this.#locals.retiredConnection !== this.#connection) return false;
    return failuresOf(error).every((cause) => retryableConnectionFailure(cause));
  }
  async #reattachLocalTrack(state: LocalTrackState, transceiver: RTCRtpTransceiver): Promise<boolean> {
    await this.#boundPeerOperation(transceiver.sender.replaceTrack(state.track));
    const held = this.#locals.held(state.source, this.#connection);
    if (held?.publication.transceiver === transceiver && !(await this.#resumeHeldPublication(held.publication, held.handle, state))) return await this.#republishAfterFailedResume(held.publication, state);
    const cause = this.#locals.paused.get(state.source);
    state.enabled = cause === undefined;
    state.desiredEnabled = state.enabled;
    state.track.enabled = state.enabled;
    if (cause === "capture_cleanup") await this.#disablePreparedTrack(state);
    else if (cause) {
      this.#pauseLocalSource(state.source, cause);
      await this.#retireOwnedPublications();
    } else {
      for (const publication of this.#locals.owned) if (publication.transceiver === transceiver) publication.detachedAt = null;
    }
    this.#publishSnapshot();
    this.#emitLocal();
    return state.enabled;
  }
  async #resumeHeldPublication(publication: OwnedLocalPublication, handle: LocalPublicationHandle, state: LocalTrackState): Promise<boolean> {
    if (!(await this.#setLocalPublicationHeld(publication, handle, false))) return false;
    // A close that overtook this resume already marked the publication retiring; it stays retiring so the waiting close still runs.
    if (publication.lifecycle.kind === "held") publication.lifecycle = { kind: "confirmed", handle };
    publication.state = state;
    publication.detachedAt = null;
    return true;
  }
  // Resumes the parked microphone on the SFU before Sync answers. It leaves the track's own state (enabled, published ID) to the
  // grant-gated enable, so nothing local shows the microphone on until Sync has granted it. A failed resume is left to that enable.
  async #resumeHeldAheadOfGrant(state: LocalTrackState, head: { readonly cancelled: boolean }): Promise<void> {
    const held = this.#locals.held(state.source, this.#connection);
    if (!held || head.cancelled || this.#locals.paused.has(state.source)) return;
    this.#locals.resumedAhead.set(state.source, held.publication);
    try {
      state.track.enabled = true;
      await this.#boundPeerOperation(held.publication.transceiver.sender.replaceTrack(state.track));
      await this.#resumeIfStillHeld(held, state, head);
      const cause = this.#locals.paused.get(state.source);
      if (cause) {
        this.#pauseLocalSource(state.source, cause);
        await this.#retireOwnedPublications();
      }
    } catch {
      // The grant-gated enable redoes the resume and reports its own failure.
    }
  }
  async #resumeIfStillHeld(held: { readonly publication: OwnedLocalPublication; readonly handle: LocalPublicationHandle }, state: LocalTrackState, head: { readonly cancelled: boolean }): Promise<void> {
    if (head.cancelled || this.#locals.held(state.source, this.#connection)?.publication !== held.publication || this.#locals.paused.has(state.source)) return;
    const resuming = this.#resumeHeldPublication(held.publication, held.handle, state);
    this.#locals.resumesInFlight.set(held.publication, resuming);
    await resuming;
  }
  // The SFU no longer holds the parked track (for example after it lost the session), so publish a new one.
  async #republishAfterFailedResume(publication: OwnedLocalPublication, state: LocalTrackState): Promise<boolean> {
    this.#locals.markRetiring(publication, "enable_failure");
    state.transceiver = null;
    state.providerPublicationId = null;
    await this.#retireOwnedPublications().catch(() => {});
    await this.#publishPreparedTracks([state], this.#generation);
    return state.enabled;
  }
  async #disablePreparedTrack(state: LocalTrackState): Promise<void> {
    const transceiver = state.transceiver;
    for (const publication of this.#locals.owned) {
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
          if (!this.#replaceMediaConnection) throw error;
          if (rejectedOnDeadConnection(error, this.#connection)) return await this.#publishOnReplacedConnections(states, generation, error);
          if (!retryableConnectionFailure(error) || this.#replacer.attemptedGeneration === generation) throw error;
          await this.#replacer.replace(generation, "local_signaling_failure");
          await this.#publishPreparedTracksSerialized(this.#tracksToPublish(states), generation, this.#connection, this.#bootstrap.connectionId);
        }
      });
    } finally {
      // Cleanup reports its own failures; another source cannot revoke this enable.
      await this.#locals.retirement.catch(() => {});
    }
  }
  #tracksToPublish(states: readonly LocalTrackState[]): LocalTrackState[] {
    return [...this.#locals.tracks.values()].filter((state) => (state.desiredEnabled || states.includes(state)) && state.track.readyState !== "ended");
  }
  // The once-per-generation replacement budget protects a connection that was up. A connection that never came up
  // gets its own short budget, so a dead session cannot keep the speaker silent until someone toggles the mic.
  async #publishOnReplacedConnections(states: readonly LocalTrackState[], generation: number, rejection: unknown): Promise<void> {
    let failure = rejection;
    for (const delayMs of DEAD_CONNECTION_REPLACEMENT_DELAYS_MS) {
      if (delayMs > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
      this.#requireGeneration(generation);
      this.#replacer.attemptedGeneration = null;
      await this.#replacer.replace(generation, "local_signaling_failure");
      try {
        await this.#publishPreparedTracksSerialized(this.#tracksToPublish(states), generation, this.#connection, this.#bootstrap.connectionId);
        return;
      } catch (error) {
        if (!rejectedOnDeadConnection(error, this.#connection)) throw error;
        failure = error;
      }
    }
    throw failure;
  }
  async #prepareConnectionForPublication(states: readonly LocalTrackState[], generation: number): Promise<readonly LocalTrackState[]> {
    if (this.#locals.retiredConnection !== this.#connection || !this.#replaceMediaConnection) {
      await this.#replacer.replaceDormantBeforeNegotiation(generation);
      const additions = states.filter((state) => !state.enabled && state.transceiver === null);
      if (!(await this.#hasSpentOfferBudget(additions, true))) return states;
      await this.#replaceForOfferSize(() => this.#replacer.replace(generation, "section_budget"));
      return this.#tracksToPublish(states);
    }
    // Retiring the bundled sender can expire the Chalk SFU connection.
    // Rebuild before publishing, retaining only other provider-authorized sources.
    const authoritative = await this.#signal(() => this.#requireTransport().listPublications());
    this.#pauseUnavailableOtherSources(authoritative.publications, states);
    this.#replacer.attemptedGeneration = null;
    await this.#replacer.replace(generation, this.#locals.retiredCause);
    return this.#tracksToPublish(states);
  }
  #pauseUnavailableOtherSources(publications: readonly SFUPublication[], states: readonly LocalTrackState[]): void {
    for (const state of this.#locals.tracks.values()) {
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
      if (!wasLive) await waitForConnectionLive(connection, () => this.#requireGeneration(generation), CONNECTION_TIMEOUT_MS);
      this.#requireGeneration(generation);
      this.#negotiatedGeneration = generation;
      this.#settleLocalPublications(publications);
      this.#publishSnapshot();
      this.#emitLocal();
    } catch (error) {
      await this.#rollbackLocalOffer(connection);
      for (const publication of publications) this.#locals.markRetiring(publication);
      this.#settleLocalPublications(publications);
      throw error;
    } finally {
      void this.#retireOwnedPublications();
    }
  }
  async #prepareLocalPublication(connection: RTCPeerConnection, state: LocalTrackState, generation: number): Promise<OwnedLocalPublication> {
    const transceiver = state.transceiver ?? addLocalTransceiver(connection, state, this.#cameraSimulcast);
    const publication: OwnedLocalPublication = { state, transceiver, trackName: `${state.source}-${globalThis.crypto.randomUUID()}`, connection, connectionId: this.#bootstrap.connectionId, detachedAt: null, lifecycle: { kind: "pending" } };
    this.#locals.owned.add(publication);
    if (state.transceiver) await this.#boundPeerOperation(transceiver.sender.replaceTrack(state.track));
    this.#requireGeneration(generation);
    state.transceiver = transceiver;
    return publication;
  }
  async #negotiateLocalPublications(connection: RTCPeerConnection, connectionId: string, publications: readonly OwnedLocalPublication[], generation: number): Promise<void> {
    let sessionDescription: Awaited<ReturnType<typeof createLocalOffer>>;
    try {
      sessionDescription = await this.#createLocalOffer(connection, "publish");
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
      sessionDescription = await this.#createLocalOffer(connection, "publish_without_simulcast");
    }
    const tracks = publications.map(
      ({ state, transceiver, trackName }): SFUTrackRequest => ({
        location: "local",
        mid: requireTransceiverMid(transceiver),
        trackName,
        source: state.source,
      }),
    );
    const response = await this.#signal(() => this.#addTracks({ connectionId, sessionDescription, tracks }), { generation, connectionId });
    this.#recordLocalPublicationHandles(publications, response.tracks);
    this.#requireGeneration(generation);
    await this.#applyProviderDescription(response, connection, { generation, connectionId });
  }
  #recordLocalPublicationHandles(publications: readonly OwnedLocalPublication[], tracks: readonly SFUTrackRequest[] | undefined): void {
    for (const publication of publications) {
      const { state, transceiver, lifecycle } = publication;
      if (lifecycle.kind === "retired") continue;
      const authoritative = tracks?.find((track) => track.location === "local" && track.mid === transceiver.mid && track.source === state.source);
      if (!authoritative?.publicationId) throw new SFUError("Missing publication ID", "invalid_publication");
      const handle = { publicationId: authoritative.publicationId, mid: requireTransceiverMid(transceiver) };
      publication.lifecycle = lifecycle.kind === "retiring" ? { ...lifecycle, handle } : { kind: "confirmed", handle };
    }
  }
  #settleLocalPublications(publications: readonly OwnedLocalPublication[]): void {
    for (const publication of publications) {
      const { state, transceiver, lifecycle } = publication;
      if (lifecycle.kind === "retired") continue;
      if (lifecycle.kind === "confirmed" && state.transceiver === transceiver && !this.#locals.paused.has(state.source)) {
        state.enabled = true;
        state.desiredEnabled = true;
        state.track.enabled = true;
        state.providerPublicationId = lifecycle.handle.publicationId;
        continue;
      }
      this.#locals.markRetiring(publication, this.#locals.paused.get(state.source) ?? "publish_failure");
      if (state.transceiver === transceiver) {
        this.#locals.clearState(state);
      }
    }
  }
  async #createLocalOffer(connection: RTCPeerConnection, origin: LocalOfferOrigin, options?: RTCOfferOptions) {
    const description = await createLocalOffer(connection, options);
    this.#localOffer = { connection, origin, at: Date.now() };
    return description;
  }
  // SDP operations are serialized, so a local offer must not outlive its operation. If one does, name its origin.
  #reportPendingLocalOffer(connection: RTCPeerConnection, where: SFULocalOfferDiagnostic["where"]): void {
    if (connection.signalingState !== "have-local-offer") return;
    const known = this.#localOffer?.connection === connection ? this.#localOffer : null;
    try {
      this.#onDiagnostic?.({ event: "local_offer_pending", where, origin: known?.origin ?? "outside_sdk", pendingMs: known ? Date.now() - known.at : null });
    } catch (error) {
      // A diagnostic callback must not abort the negotiation it describes.
      this.#reportError(error);
    }
  }
  async #rollbackLocalOffer(connection: RTCPeerConnection): Promise<void> {
    if (connection.signalingState !== "have-local-offer") return;
    try {
      await connection.setLocalDescription({ type: "rollback" });
      this.#localOffer = null;
    } catch (error) {
      this.#reportError(error);
    }
  }
  async #reconcileRemotePublications(authoritative: SFUPublicationSnapshot, generation: number): Promise<void> {
    await this.#retireDroppedReceivers(generation);
    const cursor = this.#nextRemotePublicationCursor(authoritative);
    if (cursor === null) return;
    const inputRevision = this.#pulls.inputRevision;
    const advertised = this.#desiredRemotePublications(authoritative, cursor);
    this.#receiveHealth.roster(advertised.values());
    this.#pulls.prune(new Set([...advertised.values()].map((publication) => publication.publicationId)));
    const desired = this.#visibleRemotePublications(advertised);
    // Only the authoritative roster counts: the early-pull pass sees the Sync projection, which is empty while Sync is down.
    this.#hiddenVideos = advertised.size - desired.size;
    this.#poll.noteFailedPull();
    const epoch = this.#connectionEpoch;
    const hidden = [...this.#remoteTracks].filter(([key, publication]) => isVideoPublication(publication) && advertised.get(key)?.publicationId === publication.publicationId && !desired.has(key));
    const parked = await this.#pauseVideoInPlace(hidden, generation);
    const unresumed = await this.#resumeVideoInPlace(desired, generation);
    const unclosed = await this.#closeVideo([...hidden.filter((entry) => !parked.includes(entry)), ...unresumed], generation);
    // A hidden tab polls only after a tile change, so a failed close has to ask for the retry itself.
    if (unclosed.length) this.#poll.markTilesChanged();
    const pulled = await this.#pullWithRecovery(desired, cursor, generation);
    if (pulled === null) return;
    this.#requireGeneration(generation);
    // A replacement during the pull dropped the old receivers, so keeping their entries would keep ended tracks.
    const replaced = epoch !== this.#connectionEpoch;
    const dropped = this.#commitRemoteTracks(desired, pulled, replaced ? [] : unclosed, replaced ? [] : parked, cursor, inputRevision);
    this.#announcePulledTracks(pulled);
    this.#queueDroppedReceivers(dropped);
    await this.#retireDroppedReceivers(generation);
  }
  #announcePulledTracks(pulled: readonly SFURemoteTrack[]): void {
    for (const publication of pulled) {
      this.#pulls.noteSubscribed(publication.publicationId);
      this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    }
    this.#publishSnapshot();
    this.#emitRemote();
  }
  #queueDroppedReceivers(dropped: readonly SFURemoteTrack[]): void {
    for (const publication of dropped) {
      if (this.#unretiredReceivers.size >= RECEIVER_RETIREMENT_LIMIT) break;
      this.#unretiredReceivers.set(publication, 0);
    }
  }
  #commitRemoteTracks(desired: ReadonlyMap<string, SFUPublication>, pulled: readonly SFURemoteTrack[], unclosed: readonly RemoteTrackEntry[], parked: readonly RemoteTrackEntry[], cursor: PublicationCursor, inputRevision: number): readonly SFURemoteTrack[] {
    const next = reconcileRemoteTracks(desired, pulled, this.#remoteTracks);
    for (const [key, publication] of [...unclosed, ...parked]) next.set(key, publication);
    const dropped = droppedRemoteTracks(this.#remoteTracks, next);
    this.#remoteTracks.clear();
    for (const [key, publication] of next) this.#remoteTracks.set(key, publication);
    this.#forgetViewerPauses(next.values());
    this.#cursor = cursor;
    // A video paused in place is complete: it is off screen on purpose.
    const pullIncomplete = inputRevision !== this.#pulls.inputRevision || next.size - parked.length !== desired.size || unclosed.length > 0;
    this.#pulls.settleCommit(pullIncomplete);
    if (!pullIncomplete && this.#hasLiveRemoteTracks()) this.#replacer.attemptedGeneration = null;
    return dropped;
  }
  // A withdrawn or replaced publication leaves its receive-only transceiver in the session. Without this close every remote
  // toggle adds a live m-line, so the offer and the answer grow for the whole call. A failed close stays pending and runs
  // again on the next poll, a few times, because the roster no longer lists the track and would never ask for it.
  async #retireDroppedReceivers(generation: number): Promise<void> {
    if (!this.#unretiredReceivers.size) return;
    try {
      await this.#serializeSDP(async () => {
        for (const batch of chunks([...this.#unretiredReceivers.keys()], TRACKS_PER_REQUEST)) {
          this.#requireGeneration(generation);
          const held = this.#heldRemoteTracks();
          const receivers = this.#receiversOf(batch.filter((publication) => !held.has(publication.track)));
          try {
            if (receivers.length) await this.#closeReceivers(receivers, generation);
          } catch (error) {
            for (const publication of batch) this.#countFailedRetirement(publication);
            throw error;
          }
          for (const publication of batch) this.#unretiredReceivers.delete(publication);
        }
      });
    } catch (error) {
      this.#requireGeneration(generation);
      this.#reportError(error);
    }
  }
  #countFailedRetirement(publication: SFURemoteTrack): void {
    const failures = (this.#unretiredReceivers.get(publication) ?? 0) + 1;
    if (failures >= RECEIVER_RETIREMENT_ATTEMPTS) this.#unretiredReceivers.delete(publication);
    else this.#unretiredReceivers.set(publication, failures);
  }
  #receiversOf(publications: readonly SFURemoteTrack[]) {
    return publications.flatMap((publication) => {
      const transceiver = transceiverOf(this.#connection, publication.track);
      return transceiver?.mid && !this.#closedReceiverTracks.has(publication.track) ? [{ publication, transceiver, mid: transceiver.mid }] : [];
    });
  }
  #forgetViewerPauses(kept: Iterable<SFURemoteTrack>): void {
    const ids = new Set([...kept].map((publication) => publication.publicationId));
    for (const publicationId of this.#viewerPaused) if (!ids.has(publicationId)) this.#viewerPaused.delete(publicationId);
  }
  // A hidden tile keeps its pull backoff and subscription eligibility; only a withdrawn publication loses them.
  #visibleRemotePublications(advertised: ReadonlyMap<string, SFUPublication>): Map<string, SFUPublication> {
    const video = [...advertised.values()].filter(isVideoPublication).map((publication) => publication.publicationId);
    const pulled = new Set([...this.#remoteTracks.values()].filter(isVideoPublication).map((publication) => publication.publicationId));
    // Nothing is reconciled yet: this is the join's first pull, which must not hold the video back behind the report wait.
    const { wanted, wakeAt } = this.#videoTiles.select(Date.now(), video, pulled, this.#cursor === null);
    this.#wakeForVideoTiles(wakeAt);
    // A video in picture-in-picture is on screen even while its tab is hidden or its tile is off screen.
    const floating = new Set(pictureInPictureTracks());
    const isFloating = (key: string, publicationId: string) => {
      const track = this.#remoteTracks.get(key);
      return track?.publicationId === publicationId && floating.has(track.track);
    };
    return new Map([...advertised].filter(([key, publication]) => !isVideoPublication(publication) || wanted.has(publication.publicationId) || isFloating(key, publication.publicationId)));
  }
  /** The SFU can stop an off-screen video without renegotiating, so scrolling back costs one update instead of a pull. */
  #pausesInPlace(): boolean {
    return this.#capabilities().subscriptionState && this.#transport?.updateTracks !== undefined;
  }
  #capabilities(): SFUMediaCapabilities {
    return this.#bootstrap.capabilities ?? NO_CAPABILITIES;
  }
  // Returns the hidden video that is now paused in place; the rest falls back to closing.
  async #pauseVideoInPlace(hidden: readonly RemoteTrackEntry[], generation: number): Promise<readonly RemoteTrackEntry[]> {
    if (!hidden.length || !this.#pausesInPlace()) return [];
    const pausing = hidden.filter(([, publication]) => !this.#viewerPaused.has(publication.publicationId));
    // Marked before the request: a layer update queued behind it would resume the subscription.
    for (const [, publication] of pausing) this.#viewerPaused.add(publication.publicationId);
    const failed = await this.#setVideoPaused(pausing, true, generation);
    for (const [, publication] of pausing) if (failed.has(publication.publicationId)) this.#viewerPaused.delete(publication.publicationId);
    return hidden.filter(([, publication]) => this.#viewerPaused.has(publication.publicationId));
  }
  // Returns the wanted video the SFU would not resume. Closing it lets this poll pull it again.
  async #resumeVideoInPlace(desired: ReadonlyMap<string, SFUPublication>, generation: number): Promise<readonly RemoteTrackEntry[]> {
    const resuming = [...this.#remoteTracks].filter(([key, publication]) => this.#viewerPaused.has(publication.publicationId) && desired.get(key)?.publicationId === publication.publicationId);
    if (!resuming.length) return [];
    const failed = await this.#setVideoPaused(resuming, false, generation);
    for (const [, publication] of resuming) {
      if (failed.has(publication.publicationId)) continue;
      this.#viewerPaused.delete(publication.publicationId);
      // The receiver waits for a keyframe, so it gets the startup grace instead of a stall verdict.
      this.#receiveProgress.restarted(publication.publicationId);
    }
    return resuming.filter(([, publication]) => failed.has(publication.publicationId));
  }
  // Returns the publications whose update failed.
  async #setVideoPaused(entries: readonly RemoteTrackEntry[], paused: boolean, generation: number): Promise<ReadonlySet<string>> {
    const targets = entries.flatMap(([, publication]) => {
      const mid = transceiverOf(this.#connection, publication.track)?.mid;
      const { connectionId, trackName } = parseSFUPublicationID(publication.publicationId);
      return mid ? [{ publication, request: { location: "remote", mid, sessionId: connectionId, trackName, paused } satisfies SFUTrackRequest }] : [];
    });
    const failed = new Set(entries.map(([, publication]) => publication.publicationId));
    if (!targets.length) return failed;
    try {
      const response = await this.#updateTracks(targets.map((target) => target.request));
      this.#requireGeneration(generation);
      for (const { publication, request } of targets) {
        if (!response.trackErrors?.some((error) => error.connectionId === request.sessionId && error.trackName === request.trackName)) failed.delete(publication.publicationId);
      }
    } catch (error) {
      this.#requireGeneration(generation);
      this.#reportError(error);
    }
    return failed;
  }
  #updateTracks(tracks: readonly SFUTrackRequest[]): Promise<SFUTracksResponse> {
    const transport = this.#transport;
    const connectionId = this.#bootstrap.connectionId;
    const owner = { generation: this.#generation, connectionId };
    const update = this.#trackUpdates.then(async () => {
      if (!transport?.updateTracks) throw new SFUError("This media plane cannot update tracks in place", "signaling_failed");
      // A replacement issues a token for the new connection, so an update still addressed to the old one is refused (403) by the API.
      // Owning the failure makes the error reporter drop it once the connection has changed; the new connection pulls the state afresh.
      if (this.#bootstrap.connectionId !== connectionId) throw new SFUError("Stale media connection", "stale_generation");
      const updateTracks = transport.updateTracks.bind(transport);
      return this.#signal(() => updateTracks({ connectionId, tracks }), owner);
    });
    this.#trackUpdates = update.catch(() => undefined);
    return update;
  }
  // Closing a receive-only subscription is the same call a stalled receiver uses, so it needs no provider feature.
  // Returns the video it could not close; the caller keeps it tracked so a later poll retries the close.
  async #closeVideo(hidden: readonly RemoteTrackEntry[], generation: number): Promise<readonly RemoteTrackEntry[]> {
    if (!hidden.length) return [];
    try {
      await this.#serializeSDP(async () => {
        this.#requireGeneration(generation);
        const receivers = this.#receiversOf(hidden.map(([, publication]) => publication));
        if (receivers.length) await this.#closeReceivers(receivers, generation);
      });
    } catch (error) {
      // A failed close must not stop this poll from pulling new audio and visible video.
      this.#requireGeneration(generation);
      this.#reportError(error);
      return hidden;
    }
    for (const [key] of hidden) this.#remoteTracks.delete(key);
    this.#publishSnapshot();
    this.#emitRemote();
    return [];
  }
  #nextRemotePublicationCursor(authoritative: SFUPublicationSnapshot): PublicationCursor | null {
    if (this.#cursor?.signature === INVALID_PUBLICATION_SIGNATURE && this.#cursor.incarnation === authoritative.incarnation && this.#cursor.sequence === authoritative.sequence) return null;
    let cursor: PublicationCursor;
    try {
      cursor = validatePublicationSnapshot(authoritative);
    } catch (error) {
      this.#quarantineInvalidRemotePublicationCursor(authoritative);
      throw error;
    }
    const ordering = comparePublicationCursor(this.#cursor, cursor);
    return ordering === "stale" || (ordering === "same" && !this.#pulls.incomplete) ? null : cursor;
  }
  #desiredRemotePublications(authoritative: SFUPublicationSnapshot, cursor: PublicationCursor): ReturnType<typeof desiredRemotePublications> {
    try {
      // Sync disconnection does not end an already-playing media track.
      // It does exclude abandoned participants from new subscriptions.
      const publications = authoritative.publications.filter((publication) => this.#pulls.canSubscribe(publication));
      return desiredRemotePublications(publications, this.#participantId);
    } catch (error) {
      this.#observeRemotePublicationCursor(cursor);
      throw error;
    }
  }
  async #pullWithRecovery(desired: ReadonlyMap<string, SFUPublication>, cursor: PublicationCursor, generation: number): Promise<readonly SFURemoteTrack[] | null> {
    const pending = this.#pulls.pending(desired, this.#remoteTracks, this.#receiveProgress, this.#replaceMediaConnection !== undefined);
    if (pending.length > 0 && (await this.#hasSpentOfferBudget(pending))) return this.#replaceForOfferSize(() => this.#retryRemotePullOnReplacement([...desired.values()], cursor, generation, "section_budget"));
    const stalled = pending.filter((publication) => this.#receiveProgress.isStalled(publication.publicationId));
    if (stalled.length) return this.#recoverStalledRemotePublications(stalled, desired, cursor, generation);
    try {
      return await this.#pull(pending, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      if (!this.#canReplaceConnectionAfterRemotePull(error, generation)) {
        this.#observeRemotePublicationCursor(cursor, retryableRemotePull(error));
        throw error;
      }
      return this.#retryRemotePullOnReplacement(pending, cursor, generation);
    }
  }
  async #measureLocalOffer(connection: RTCPeerConnection): Promise<ReturnType<typeof measureOffer>> {
    return measureOffer((await connection.createOffer()).sdp ?? "");
  }
  // A safety valve: the media node reuses closed sections, so the offer should not grow this far. When it does, the replacement is logged here and reported to the API as cause section_budget.
  async #hasSpentOfferBudget(tracks: readonly Pick<SFUPublication, "source">[], inQueue = false, announce = true): Promise<boolean> {
    if (!this.#replaceMediaConnection) return false;
    const connection = this.#connection;
    const measure = () => this.#measureLocalOffer(connection);
    const size = inQueue ? await measure() : await this.#serializeSDP(measure);
    const additionalBytes = expectedOfferAddition(tracks);
    if (!shouldReplaceForOfferSize(size, { additionalBytes, coolingDown: Date.now() < this.#offerBudgetCooldownUntil })) return false;
    if (announce)
      console.warn(
        `Chalk media: replacing the media connection because its projected next offer is ${size.bytes + additionalBytes} bytes (${size.reclaimableBytes} in closed or parked sections) and the media node refuses offers over ${OFFER_SIZE_LIMIT_BYTES}. Closed sections should not pile up; report this.`,
      );
    return true;
  }
  // The size budget is not a recovery from a failure, so it neither needs nor spends the generation's one recovery replacement.
  // Whatever its outcome, the next one waits out the cooldown, except near the node's cap, where there is no cooldown.
  async #replaceForOfferSize<T>(replace: () => Promise<T>): Promise<T> {
    this.#offerBudgetCooldownUntil = Date.now() + OFFER_REPLACEMENT_COOLDOWN_MS;
    this.#replacer.attemptedGeneration = null;
    try {
      return await replace();
    } finally {
      this.#replacer.attemptedGeneration = null;
    }
  }
  async #recoverStalledRemotePublications(stalled: readonly SFUPublication[], desired: ReadonlyMap<string, SFUPublication>, cursor: PublicationCursor, generation: number): Promise<readonly SFURemoteTrack[] | null> {
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
  async #repullStalledRemotePublications(stalled: readonly SFUPublication[], generation: number): Promise<readonly SFURemoteTrack[] | null> {
    for (const publication of stalled) this.#receiveProgress.reserveRepull(publication.publicationId);
    const retired = await this.#retireStalledReceivers(stalled, generation);
    if (!retired.length) return [];
    const pulled = await this.#pullInRequests(retired, generation, (batch) => this.#pullBatch(batch, generation));
    if (pulled?.length !== retired.length) throw new SFUError("Stalled receive subscriptions were not restored", "media_failed");
    for (const publication of retired) this.#receiveProgress.restarted(publication.publicationId);
    return pulled;
  }
  async #retireStalledReceivers(publications: readonly SFUPublication[], generation: number): Promise<readonly SFUPublication[]> {
    return this.#serializeSDP(async () => {
      this.#requireGeneration(generation);
      const stalled = publications.filter((publication) => this.#receiveProgress.isStalled(publication.publicationId));
      if (!stalled.length) return [];
      const connection = this.#connection;
      const receivers = stalled.map((publication) => {
        const remote = [...this.#remoteTracks.values()].find((track) => track.publicationId === publication.publicationId);
        const transceiver = remote && transceiverOf(connection, remote.track);
        if (!transceiver || transceiver.mid === null) throw new SFUError("The stalled receiver has no negotiated MID", "media_failed");
        return { publication, transceiver, mid: transceiver.mid };
      });
      await this.#closeReceivers(receivers, generation);
      return stalled;
    });
  }
  async #closeReceivers(receivers: readonly { readonly publication: Pick<SFUPublication, "publicationId" | "source">; readonly transceiver: RTCRtpTransceiver; readonly mid: string }[], generation: number): Promise<void> {
    const connectionId = this.#bootstrap.connectionId;
    // The SFU rejects a request of more than 16 tracks. A forced close of a closed track answers alreadyClosed, so a retry after a partial failure is safe.
    for (const batch of chunks(receivers, TRACKS_PER_REQUEST)) {
      await this.#signal(() => this.#requireTransport().closeTracks({ connectionId, receiveOnly: true, force: true, tracks: batch.map(({ publication, mid }) => ({ mid, source: publication.source, publicationId: publication.publicationId })) }), { generation, connectionId });
      this.#requireGeneration(generation);
      for (const { transceiver } of batch) {
        this.#closedReceiverTracks.add(transceiver.receiver.track);
        // Park the receiver inactive; never stop it or its track. Stopping moves no SDP, so the next offer of any kind would
        // reject the m-section (the BUNDLE tag's rejection drops the transport and the SFU session with it), and the SFU
        // reuses a closed mid for the next pull of that guest. A stopped transceiver or track would receive that pull with
        // nothing to play it. #reviveInactiveTransceivers turns the receiver on again when the SFU's offer reuses the mid.
        transceiver.direction = "inactive";
      }
      this.#invokeListener(() => this.#onReceiveHealth?.({ event: "receivers_closed", receivers_stopped: batch.length, bundle_tag_held: batch.some(({ mid }) => mid === bundleTagOf(this.#connection)) }));
    }
  }
  #reportHealth(event: TransportDiagnostic): void {
    this.#invokeListener(() => this.#onReceiveHealth?.(event));
  }
  #heldRemoteTracks(): ReadonlySet<MediaStreamTrack> {
    return new Set([...this.#remoteTracks.values()].map((publication) => publication.track));
  }
  #canReplaceConnectionAfterRemotePull(error: unknown, generation: number): boolean {
    return retryableConnectionFailure(error) && (isGoneStatus(error) || !this.#hasLiveRemoteTracks()) && this.#replaceMediaConnection !== undefined && this.#replacer.attemptedGeneration !== generation;
  }
  #hasLiveRemoteTracks(): boolean {
    return [...this.#remoteTracks.values()].some((publication) => publication.track.readyState === "live");
  }
  async #retryRemotePullOnReplacement(publications: readonly SFUPublication[], cursor: PublicationCursor, generation: number, cause: MediaConnectionReplacementCause = "remote_signaling_failure"): Promise<readonly SFURemoteTrack[] | null> {
    this.#pulls.recoveryGeneration = generation;
    const connection = this.#connection;
    try {
      await this.#replacer.replace(generation, cause);
      await this.#republishPreparedTracksAfterRecovery(generation);
      return await this.#pull(publications, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      if (cause === "receive_stalled" && connection === this.#connection) {
        this.#replacer.attemptedGeneration = null;
        for (const publication of publications) this.#pulls.backoff(publication.publicationId, true);
      }
      this.#observeRemotePublicationCursor(cursor, retryableRemotePull(error));
      throw error;
    }
  }
  async #pull(publications: readonly SFUPublication[], generation: number): Promise<readonly SFURemoteTrack[] | null> {
    const eligible = publications.filter((publication) => this.#pulls.canSubscribe(publication));
    return this.#pullInRequests(eligible, generation, (batch) => this.#pullWithFallback(batch, generation));
  }
  // One request pulls at most 16 tracks. A later batch that fails keeps what the earlier batches already pulled; the roster pulls the rest on the next poll.
  async #pullInRequests(publications: readonly SFUPublication[], generation: number, pullBatch: (batch: readonly SFUPublication[]) => Promise<readonly SFURemoteTrack[]>): Promise<readonly SFURemoteTrack[]> {
    const pulled: SFURemoteTrack[] = [];
    for (const [index, batch] of [...chunks(publications, TRACKS_PER_REQUEST)].entries()) {
      try {
        pulled.push(...(await pullBatch(batch)));
      } catch (error) {
        this.#requireGeneration(generation);
        // The failed batch is already deferred. Later batches wait out the same error instead of hitting a refusing SFU at once.
        this.#pulls.defer(publications.slice((index + 1) * TRACKS_PER_REQUEST), error);
        if (!pulled.length) throw error;
        this.#reportError(error);
        break;
      }
    }
    return pulled;
  }
  async #pullWithFallback(eligible: readonly SFUPublication[], generation: number): Promise<readonly SFURemoteTrack[]> {
    try {
      return await this.#pullBatch(eligible, generation);
    } catch (error) {
      this.#requireGeneration(generation);
      if (eligible.length <= 1 || !retryableRemotePull(error) || isRateLimited(error) || this.#canReplaceConnectionAfterRemotePull(error, generation) || isGoneStatus(error)) {
        this.#pulls.defer(eligible, error);
        throw error;
      }
    }
    return this.#pullIndividually(eligible, generation);
  }
  async #pullIndividually(eligible: readonly SFUPublication[], generation: number): Promise<readonly SFURemoteTrack[]> {
    const pulled: SFURemoteTrack[] = [];
    let failure: unknown;
    // Healthy subscriptions stay batched; isolate only a failed batch.
    for (const [index, publication] of eligible.entries()) {
      if (!this.#pulls.canSubscribe(publication)) continue;
      try {
        pulled.push(...(await this.#pullBatch([publication], generation)));
      } catch (error) {
        this.#requireGeneration(generation);
        this.#pulls.defer([publication], error);
        this.#reportError(error);
        if (failure === undefined || retryableRemotePull(error)) failure = error;
        if (isRateLimited(error)) {
          this.#pulls.defer(eligible.slice(index + 1), error);
          break;
        }
      }
    }
    if (failure && pulled.length === 0) throw failure;
    return pulled;
  }
  async #pullBatch(publications: readonly SFUPublication[], generation: number): Promise<readonly SFURemoteTrack[]> {
    if (publications.length === 0) return [];
    return observeOperation(this.#telemetry, { action: "subscribe" }, () => this.#pullTracks(publications, generation), subscribeFailure, pullShortfall(publications.length));
  }
  async #pullTracks(publications: readonly SFUPublication[], generation: number): Promise<readonly SFURemoteTrack[]> {
    this.#receiveHealth.pullRequested(publications.map((publication) => publication.publicationId));
    return this.#serializeSDP(() =>
      this.#negotiateRemotePull(publications, generation, async (connectionId) => {
        const requested = publications.map((publication): SFUTrackRequest => {
          const reference = parseSFUPublicationID(publication.publicationId);
          return {
            location: "remote",
            sessionId: reference.connectionId,
            trackName: reference.trackName,
            // h sorts before l: prefer full camera quality, but keep video flowing
            // when the publisher pauses h. Do not silently downgrade a live h layer.
            ...(publication.source === "camera" ? { simulcast: { preferredRid: "h", priorityOrdering: "none", ridNotAvailable: "asciibetical" } as const } : {}),
          };
        });
        const response = await this.#signal(() => this.#addTracks({ connectionId, tracks: requested, allowPartialRemoteTracks: true }), { generation, connectionId });
        return { publications, response };
      }),
    );
  }
  // The join's first poll: one request lists the publications and pulls the other Participants' audio. The tracks
  // join the roster before the normal reconcile runs, so it only has the video left to pull.
  async #pullPublishedAudio(pull: NonNullable<SFUSignalingTransport["pullPublishedAudio"]>, generation: number): Promise<SFUPublicationSnapshot> {
    const listed: { snapshot?: SFUPublicationSnapshot } = {};
    const pulled = await this.#serializeSDP(() =>
      this.#negotiateRemotePull([], generation, async (connectionId) => {
        const issued = await this.#signal(() => pull({ connectionId }), { generation, connectionId });
        listed.snapshot = issued.snapshot;
        const audio = issued.snapshot.publications.filter((publication) => publication.participantId !== this.#participantId && !isVideoPublication(publication));
        this.#receiveHealth.pullRequested(audio.map((publication) => publication.publicationId));
        return { publications: audio, response: issued.response };
      }),
    );
    if (!listed.snapshot) throw new SFUError("The pull-published request returned no publications", "signaling_failed");
    // The server pulled every listed audio track. The roster still decides which ones this client keeps.
    const kept = pulled.filter((publication) => this.#pulls.canSubscribe(publication));
    const roster = reconcileRemoteTracks(desiredRemotePublications(kept, this.#participantId), kept, this.#remoteTracks);
    for (const [key, publication] of roster) this.#remoteTracks.set(key, publication);
    for (const publication of kept) {
      this.#pulls.noteSubscribed(publication.publicationId);
      this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    }
    // The server also pulled the tracks of Participants the roster does not list. No roster entry holds those receivers, so the reconcile that follows retires them.
    const held = this.#heldRemoteTracks();
    this.#queueDroppedReceivers(pulled.filter((publication) => !held.has(publication.track)));
    return listed.snapshot;
  }
  async #negotiateRemotePull(requested: readonly SFUPublication[], generation: number, issue: (connectionId: string) => Promise<{ readonly publications: readonly SFUPublication[]; readonly response: SFUTracksResponse }>): Promise<readonly SFURemoteTrack[]> {
    const connection = this.#connection;
    const connectionId = this.#bootstrap.connectionId;
    let publications = requested;
    let matched: ReturnType<typeof matchRemotePullTracks> = [];
    const received = new Map<string, MediaStreamTrack>();
    const onTrack = (event: RTCTrackEvent) => {
      if (event.transceiver.mid === null) return;
      received.set(event.transceiver.mid, event.track);
      // The SFU reused a parked receiver's mid for this pull, so this receiver can be closed again later.
      this.#closedReceiverTracks.delete(event.track);
    };
    connection.addEventListener("track", onTrack);
    try {
      this.#requireGeneration(generation);
      const issued = await issue(connectionId);
      publications = issued.publications;
      const response = issued.response;
      this.#requireGeneration(generation);
      this.#recordRemotePullErrors(publications, response.trackErrors ?? []);
      const responseTracks = response.tracks ?? [];
      matched = matchRemotePullTracks(publications, responseTracks);
      for (const { publication } of matched) {
        this.#pulls.forgetUnstalled(publication.publicationId);
      }
      await this.#completeRenegotiation(response, connection, connectionId, generation);
      if (matched.length === 0) return [];
      await waitForConnectionLive(connection, () => this.#requireGeneration(generation), CONNECTION_TIMEOUT_MS).catch((error: unknown) => {
        // A connection that never went live is not a transient pull error: report it so the call recovers or fails.
        if (connection === this.#connection && this.#connectedEpoch !== this.#connectionEpoch && generation === this.#generation && !this.#stopped) this.#setFailure(error, "media_failed");
        throw error;
      });
      this.#negotiatedGeneration = generation;
      // The browser fires no track event when the SFU reuses a closed receiver that still receives the same stream, so a revived receiver counts as arrived.
      const arrived = (mid: string) => received.get(mid) ?? this.#revivedReceiverTrack(connection, mid);
      await waitFor(() => responseTracks.every((track) => track.mid !== undefined && arrived(track.mid) !== undefined), 5000);
      this.#requireGeneration(generation);
      return matched.map(({ publication, mid }) => {
        const track = arrived(mid);
        if (!track) throw new SFUError("A negotiated remote track did not arrive", "media_failed");
        this.#closedReceiverTracks.delete(track);
        this.#receiveHealth.pullSucceeded([publication.publicationId]);
        return Object.freeze({ ...publication, track });
      });
    } catch (error) {
      this.#recordReceivePullFailure(publications, generation, error);
      this.#queueUnclaimedReceivers(connection, matched, (mid) => received.get(mid) ?? this.#revivedReceiverTrack(connection, mid));
      throw error;
    } finally {
      connection.removeEventListener("track", onTrack);
    }
  }
  // A pull that fails after the browser fired its track events leaves live receivers that no roster entry holds. The next poll retires them.
  #queueUnclaimedReceivers(connection: RTCPeerConnection, matched: ReturnType<typeof matchRemotePullTracks>, arrived: (mid: string) => MediaStreamTrack | undefined): void {
    if (connection !== this.#connection) return;
    const held = this.#heldRemoteTracks();
    for (const { publication, mid } of matched) {
      const track = arrived(mid);
      if (track === undefined || held.has(track) || this.#unretiredReceivers.size >= RECEIVER_RETIREMENT_LIMIT) continue;
      this.#closedReceiverTracks.delete(track);
      this.#unretiredReceivers.set(Object.freeze({ ...publication, track }), 0);
    }
  }
  // A receiver this client closed and the SFU's offer turned on again (see #reviveInactiveTransceivers) holds the track of the reused mid.
  #revivedReceiverTrack(connection: RTCPeerConnection, mid: string): MediaStreamTrack | undefined {
    const transceiver = connection.getTransceivers().find((item) => item.mid === mid);
    const track = transceiver?.receiver.track;
    return transceiver?.direction === "recvonly" && track !== undefined && this.#closedReceiverTracks.has(track) ? track : undefined;
  }
  #recordRemotePullErrors(publications: readonly SFUPublication[], failures: NonNullable<SFUTracksResponse["trackErrors"]>): void {
    const requested = publicationsByTrack(publications);
    for (const failure of failures) {
      const publication = requested.get(trackKey(failure.connectionId, failure.trackName));
      if (!publication) throw new SFUError("Chalk SFU returned an unrequested remote track error", "invalid_publication");
      // A republished track can be discovered before the provider can pull it.
      // Keep its backoff independent of polls restarted by unrelated presence.
      this.#pulls.backoff(publication.publicationId);
      this.#receiveHealth.pullFailed(publication.publicationId, "SFUError");
      this.#reportError(new SFUError(`Chalk SFU remote track failed: ${failure.code}`, "media_failed", { providerCode: failure.code }));
    }
  }
  #recordReceivePullFailure(publications: readonly SFUPublication[], generation: number, error: unknown): void {
    if (generation !== this.#generation || (error instanceof SFUError && error.code === "stale_generation")) return;
    const kind = classifyMediaFailure(error, "sfu_tracks").media_error_kind;
    for (const publication of publications) this.#receiveHealth.pullFailed(publication.publicationId, kind);
  }
  #adaptViewerLayers(connection: RTCPeerConnection, report: RTCStatsReport, selector: ViewerLayerSelector, current: () => boolean): void {
    if (!this.#transport?.updateTracks || !this.#canObserveReceiveProgress(connection)) return;
    const now = performance.now();
    // A layer update also resumes, so a camera paused in place gets none, but the selector keeps its ceiling.
    const cameras = [...this.#remoteTracks.values()].filter(({ source, track }) => source === "camera" && track.readyState === "live");
    this.#queueViewerLayers(selector.sample(now, report, cameras, this.#viewerPaused));
    if (this.#viewerLayerUpdating || now < this.#viewerLayerUpdateAt) return;
    const batch = [...this.#viewerLayerPending.values()]
      .filter((change) => !this.#viewerPaused.has(change.publicationId))
      .flatMap((change) => {
        const mid = transceiverOf(connection, change.track)?.mid;
        return mid === null || mid === undefined ? [] : [{ change, mid }];
      })
      .slice(0, VIEWER_LAYER_BATCH_SIZE);
    if (!batch.length) return;
    this.#viewerLayerUpdating = true;
    this.#viewerLayerUpdateAt = now + VIEWER_LAYER_UPDATE_INTERVAL_MS;
    void this.#requestViewerLayers(batch).then((failed) => {
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
  #queueViewerLayers(changes: readonly ViewerLayerChange[]): void {
    const active = new Set(changes.map(({ publicationId }) => publicationId));
    for (const id of this.#viewerLayerPending.keys()) if (!active.has(id)) this.#viewerLayerPending.delete(id);
    for (const change of changes) this.#viewerLayerPending.set(change.publicationId, change);
  }
  // A layer switch is an optimization: when the SFU refuses it, the pulled layer keeps playing.
  async #requestViewerLayers(batch: readonly { readonly change: ViewerLayerChange; readonly mid: string }[]): Promise<ReadonlySet<string>> {
    try {
      const response = await this.#updateTracks(
        batch.map(({ change, mid }) => {
          const { connectionId, trackName } = parseSFUPublicationID(change.publicationId);
          return { location: "remote", mid, sessionId: connectionId, trackName, simulcast: { preferredRid: change.layer, priorityOrdering: "none", ridNotAvailable: "asciibetical" } };
        }),
      );
      return new Set(
        batch
          .filter(({ change }) => {
            const { connectionId, trackName } = parseSFUPublicationID(change.publicationId);
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
  #observeReceiveProgress(connection: RTCPeerConnection, report: RTCStatsReport, current: () => boolean): void {
    if (!this.#canObserveReceiveProgress(connection)) {
      this.#receiveProgress.clear();
      return;
    }
    const now = performance.now();
    // A video paused in place sends nothing on purpose.
    const received = [...this.#remoteTracks.values()].filter((publication) => !this.#viewerPaused.has(publication.publicationId));
    const reads = this.#readsSubscriptions();
    const { stalled, advanced } = this.#receiveProgress.sample(now, connection, report, received, reads ? (id) => this.#delivery.held(id, now) : undefined);
    for (const publicationId of advanced) this.#pulls.forget(publicationId);
    if (reads) this.#observeDelivery(now, connection, received, new Set(advanced), current);
    this.#publishSnapshot();
    if (!stalled.some((id) => this.#receiveProgress.canRepull(id) || (this.#replaceMediaConnection && this.#receiveProgress.canRebuild(id)))) return;
    for (const publicationId of stalled) {
      if (!this.#pulls.isReceiveStalled(publicationId)) this.#pulls.backoff(publicationId, true);
    }
    this.#pulls.markIncomplete();
    this.remotePublicationsChanged();
  }
  // The SFU answers 404 or 410 once it has dropped this session, and ICE cannot bring a dropped session back. Replace now,
  // instead of waiting for the browser to give up on the path and for the ICE restart on the dead session to fail.
  // An SDP operation in flight talks to the same dropped session and replaces the connection itself when it fails, and a read
  // that finds the session still gone repeats within seconds. Replacing under it would clear the state that operation reads.
  #readsSubscriptions(): boolean {
    return this.#capabilities().subscriptionState && this.#transport?.listSubscriptions !== undefined;
  }
  // The SFU's subscription state decides whether a quiet video is stalled or paused for network.
  #observeDelivery(now: number, connection: RTCPeerConnection, received: readonly SFURemoteTrack[], advanced: ReadonlySet<string>, current: () => boolean): void {
    const videos = received.flatMap((publication): DeliveredVideo[] => {
      if (!isVideoPublication(publication)) return [];
      const mid = transceiverOf(connection, publication.track)?.mid;
      if (!mid) return [];
      const { connectionId, trackName } = parseSFUPublicationID(publication.publicationId);
      return [{ publicationId: publication.publicationId, trackId: publication.track.id, mid, sessionId: connectionId, trackName }];
    });
    this.#delivery.observe(now, videos, advanced);
    const listSubscriptions = this.#transport?.listSubscriptions;
    if (!listSubscriptions || !this.#delivery.needsRead(now)) return;
    const startedAt = this.#delivery.begin(now);
    void listSubscriptions().then(
      (states) => {
        if (!current()) return;
        for (const publicationId of this.#delivery.applied(startedAt, states)) this.#receiveProgress.restarted(publicationId);
        this.#publishSnapshot();
      },
      (error) => {
        if (!current()) return;
        this.#delivery.failed(startedAt, performance.now());
        if (error instanceof SFUError && (error.options.status === 404 || error.options.status === 410)) this.#replacer.replaceGone();
      },
    );
  }
  async #completeRenegotiation(response: SFUTracksResponse, connection: RTCPeerConnection, connectionId: string, generation: number): Promise<void> {
    if (response.sessionDescription?.type === "offer") await this.#applyProviderDescription(response, connection, { generation, connectionId });
  }
  // An answer completes our own offer. An offer comes from the SFU and must always be answered:
  // this peer is the polite one, so it rolls back a pending local offer first. A browser that
  // rolls back on its own would otherwise leave the SFU's offer unanswered.
  async #applyProviderDescription(response: SFUTracksResponse, connection: RTCPeerConnection, owner: { readonly generation: number; readonly connectionId: string }): Promise<void> {
    const description = requireSFUDescription(response.sessionDescription);
    if (description.type !== "offer") {
      await connection.setRemoteDescription(description);
      this.#localOffer = null;
      return;
    }
    this.#reportPendingLocalOffer(connection, "remote_offer");
    await this.#rollbackLocalOffer(connection);
    await connection.setRemoteDescription(description);
    this.#reviveInactiveTransceivers(connection, description.sdp, response);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await this.#signal(() => this.#requireTransport().renegotiate({ connectionId: owner.connectionId, sessionDescription: requireDescription(answer) }), owner);
    this.#requireGeneration(owner.generation);
  }
  // An answer cannot enable a section that this side set inactive. The SFU reuses a closed mid for its next pull: the mid of a
  // parked receiver, or of our own muted microphone or camera. So an inactive transceiver that the request's response names and
  // that the offer turns on must receive again before the answer is made. Leave other mids parked.
  #reviveInactiveTransceivers(connection: RTCPeerConnection, offerSDP: string, response: SFUTracksResponse): void {
    const named = new Set((response.tracks ?? []).map((track) => track.mid));
    const active = activeOfferedMids(offerSDP);
    for (const transceiver of connection.getTransceivers()) {
      const { mid } = transceiver;
      if (transceiver.direction === "inactive" && mid !== null && named.has(mid) && active.has(mid)) transceiver.direction = "recvonly";
    }
  }
  async #applyProviderDescriptionIfOpen(response: SFUTracksResponse, connection: RTCPeerConnection, owner: { readonly generation: number; readonly connectionId: string }): Promise<void> {
    if (!connectionIsClosed(connection)) await this.#applyProviderDescription(response, connection, owner);
  }
  #serializeSDP<T>(operation: () => Promise<T>, retirement = false): Promise<T> {
    const generation = this.#generation;
    this.#sdpPending += 1;
    let expired = false;
    const timeout = new SFUError("Chalk SFU negotiation timed out. Try again.", "negotiation_timeout");
    const run = () => {
      if (expired || (!retirement && generation !== this.#generation)) throw timeout;
      this.#reportPendingLocalOffer(this.#connection, "sdp_operation_start");
      return operation();
    };
    const pending = this.#sdpTail.then(run, run);
    const result = withDeadline(pending, NEGOTIATION_TIMEOUT_MS, () => {
      expired = true;
      if (generation === this.#generation && !this.#stopped) this.#expireNegotiation(timeout);
      return timeout;
    })
      .catch((error: unknown) => {
        if (error instanceof SFUError && error.code === "signaling_timeout" && generation === this.#generation && !this.#stopped) this.#expireNegotiation(error);
        throw error;
      })
      .finally(() => {
        this.#sdpPending -= 1;
      });
    this.#sdpTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async #boundPeerOperation(operation: Promise<void>): Promise<void> {
    const generation = this.#generation;
    const timeout = new SFUError("The browser media operation timed out. Try again.", "negotiation_timeout");
    await withDeadline(operation, PEER_OPERATION_TIMEOUT_MS, () => {
      if (generation === this.#generation && !this.#stopped) this.#expireNegotiation(timeout);
      return timeout;
    });
  }
  #expireNegotiation(error: SFUError): void {
    this.#generation++;
    this.#connectionEpoch++;
    this.#poll.interrupt();
    this.#publishSnapshot("recovering", null);
    this.#disposeConnection(false);
    this.#setFailure(error, "media_failed");
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
    let disconnectedTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const cameraPolicy = new CameraUplinkPolicy();
    const viewerLayers = new ViewerLayerSelector({ followsNetwork: !this.#capabilities().serverLayerAdaptation });
    let observedCamera: LocalTrackState | undefined;
    const owned = () => !disposed && generation === this.#generation && connectionEpoch === this.#connectionEpoch && !this.#stopped;
    const observed = () => owned() && connection.connectionState !== "closed";
    const current = () => observed() && connection.connectionState !== "failed";
    // Sampling skips a failed path but keeps its schedule, so an ICE restart on the same connection resumes it.
    const adaptCamera = async () => {
      try {
        if (!current()) return;
        const state = this.#locals.tracks.get("camera");
        if (state !== observedCamera) {
          cameraPolicy.reset();
          observedCamera = state;
        }
        const report = await connection.getStats();
        if (!current() || connection.signalingState !== "stable") return;
        this.#observeReceiveProgress(connection, report, current);
        this.#adaptViewerLayers(connection, report, viewerLayers, current);
        this.#callStats.observe(report, { hiddenVideos: this.#hiddenVideos, playout: (trackId) => this.#receiveHealth.playout(trackId), ...(this.#readsSubscriptions() ? { pausedVideos: this.#delivery.pausedForNetwork } : {}) });
        this.#publishCallStats();
        const sender = this.#cameraSimulcastSender(state);
        if (!sender) cameraPolicy.reset();
        else await this.#applyCameraUplink(sender, report, cameraPolicy);
      } catch {
        // Stats and optional sender controls must never break publication.
        cameraPolicy.reset();
      } finally {
        if (observed()) cameraTimer = globalThis.setTimeout(adaptCamera, 1000);
      }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.#viewerLayerPending.clear();
      if (cameraTimer !== undefined) globalThis.clearTimeout(cameraTimer);
      if (disconnectedTimer !== undefined) globalThis.clearTimeout(disconnectedTimer);
      connection.removeEventListener("connectionstatechange", capture);
      connection.removeEventListener("iceconnectionstatechange", capture);
      connection.removeEventListener("signalingstatechange", capture);
    };
    const observe = () => {
      if (!owned()) return;
      if (connectionIsLive(connection)) this.#connectedEpoch = connectionEpoch;
      const observation = this.#ice.observe(connection, connectionEpoch, observeConnectionState(connection.connectionState, connection.iceConnectionState, this.#started));
      if (observation) this.#publishSnapshot(observation.phase, observation.failure);
      else this.#publishSnapshot();
      watchDisconnected();
    };
    // A disconnected path often never reaches "failed" quickly, so restart ICE after a short wait.
    const watchDisconnected = () => {
      if (connection.iceConnectionState !== "disconnected" || !this.#restartsIceInPlace()) {
        if (disconnectedTimer !== undefined) globalThis.clearTimeout(disconnectedTimer);
        disconnectedTimer = undefined;
        return;
      }
      disconnectedTimer ??= globalThis.setTimeout(() => {
        disconnectedTimer = undefined;
        if (disposed || connection.iceConnectionState !== "disconnected") return;
        this.#ice.begin(connection, generation, connectionEpoch);
        observe();
      }, ICE_DISCONNECTED_RESTART_MS);
    };
    const capture = () => {
      if (!owned()) return;
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
  #restartsIceInPlace(): boolean {
    return this.#started && this.#capabilities().iceRestart;
  }
  #addTracks(input: Omit<Parameters<SFUSignalingTransport["addTracks"]>[0], "replacementCause">): Promise<SFUTracksResponse> {
    // The first signaling attempt on the new binding reports its origin, even if
    // that attempt fails. Extra query parameters also work with older APIs.
    const replacementCause = this.#replacer.takeCause();
    return this.#requireTransport().addTracks({ ...input, replacementCause });
  }
  #adoptReplacement(bootstrap: SFUBootstrap, cause: MediaConnectionReplacementCause): void {
    this.#locals.fence();
    const connectionEpoch = ++this.#connectionEpoch;
    // A connection that never negotiated carried nothing, so swapping it is no recovery. Saying "recovering" would
    // move the whole call to reconnecting and cut off any other enable that is running.
    if (cause !== "dormant_connection") this.#publishSnapshot("recovering", null);
    this.#disposeConnection(false);
    this.#clearRemoteTracks();
    this.#cursor = null;
    this.#bootstrap = bootstrap;
    this.#rebuildPeerConnection(bootstrap, this.#generation, connectionEpoch);
    this.#replacer.noteCause(cause);
    this.#locals.retiredConnection = null;
    this.#negotiatedGeneration = null;
    for (const state of this.#locals.tracks.values()) {
      state.transceiver = null;
      state.enabled = false;
      state.providerPublicationId = null;
    }
    this.remotePublicationsChanged();
  }
  async #republishPreparedTracksAfterRecovery(generation: number): Promise<void> {
    const enabled = [...this.#locals.tracks.values()].filter((state) => state.desiredEnabled && state.track.readyState !== "ended");
    await this.#publishPreparedTracks(enabled, generation);
    await this.#ice.establishReceiveTransport(generation);
  }
  #observeRemotePublicationCursor(cursor: PublicationCursor, pullIncomplete = false): void {
    this.#cursor = cursor;
    this.#pulls.observeCursor(pullIncomplete);
    this.#publishSnapshot();
  }
  #quarantineInvalidRemotePublicationCursor(authoritative: SFUPublicationSnapshot): void {
    if (!Number.isSafeInteger(authoritative.incarnation) || authoritative.incarnation < 0 || !Number.isSafeInteger(authoritative.sequence) || authoritative.sequence < 0) return;
    this.#observeRemotePublicationCursor({ incarnation: authoritative.incarnation, sequence: authoritative.sequence, signature: INVALID_PUBLICATION_SIGNATURE });
  }
  #createPeerConnection(bootstrap: SFUBootstrap): RTCPeerConnection {
    const create = this.#peerConnectionFactory ?? ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
    return create({ iceServers: iceServersFor(bootstrap), bundlePolicy: "max-bundle", iceCandidatePoolSize: 1 });
  }
  #rebuildPeerConnection(bootstrap: SFUBootstrap, generation: number, connectionEpoch: number): void {
    try {
      this.#connection = this.#createPeerConnection(bootstrap);
      this.#callStats.reset();
      this.#observeConnection(this.#connection, generation, connectionEpoch);
    } catch (error) {
      this.#setFailure(error, "media_failed");
      throw error;
    }
  }
  #disposeConnection(stopSenders: boolean): void {
    this.#receiveHealth.replaced();
    this.#receiveProgress.replaced();
    this.#disposeConnectionObservation?.();
    this.#disposeConnectionObservation = undefined;
    if (stopSenders) {
      for (const sender of this.#connection.getSenders()) {
        if (sender.track) safeStopTrack(sender.track, this.#reportError.bind(this));
      }
    }
    for (const transceiver of this.#connection.getTransceivers()) safeStopTransceiver(transceiver, this.#reportError.bind(this));
    try {
      this.#connection.close();
    } catch (error) {
      this.#reportError(error);
    }
  }
  #clearRemoteTracks(): void {
    for (const publication of this.#remoteTracks.values()) safeStopTrack(publication.track, this.#reportError.bind(this));
    this.#remoteTracks.clear();
    this.#unretiredReceivers.clear();
    this.#viewerPaused.clear();
    this.#delivery.clear();
    this.#publishSnapshot();
    this.#emitRemote();
  }
  #observeVideoTiles(): () => void {
    const stopReports = this.#videoTiles.observe(() => this.#reconcileVideoTiles());
    if (typeof document === "undefined") return stopReports;
    const onPage = () => {
      this.#videoTiles.page(pageIsHidden(), Date.now());
      this.#reconcileVideoTiles();
    };
    // Capture, so the picture-in-picture events reach the document even where a browser does not bubble them.
    for (const event of PAGE_VISIBILITY_EVENTS) document.addEventListener(event, onPage, { capture: true });
    return () => {
      stopReports();
      for (const event of PAGE_VISIBILITY_EVENTS) document.removeEventListener(event, onPage, { capture: true });
      if (this.#videoTileWake !== undefined) globalThis.clearTimeout(this.#videoTileWake);
      this.#videoTileWake = undefined;
    };
  }
  #reconcileVideoTiles(): void {
    if (this.#stopped || (!this.#started && !this.#receivingInitial)) return;
    this.#poll.markTilesChanged();
    this.#pulls.noteInputChanged();
    this.remotePublicationsChanged();
  }
  #wakeForVideoTiles(wakeAt: number | undefined): void {
    if (this.#videoTileWake !== undefined) globalThis.clearTimeout(this.#videoTileWake);
    this.#videoTileWake = undefined;
    if (wakeAt === undefined || this.#stopped) return;
    this.#videoTileWake = globalThis.setTimeout(
      () => {
        this.#videoTileWake = undefined;
        this.#reconcileVideoTiles();
      },
      Math.max(0, wakeAt - Date.now()),
    );
  }
  #heldTrackSyncShowsOff(): boolean {
    return this.#syncPublications.some(({ participantId, source, enabled }) => !enabled && this.#remoteTracks.has(publicationKey({ participantId, source })));
  }
  #projectLocalPublications(): readonly MediaPublication[] {
    return [...this.#locals.tracks.values()].map((state) => ({
      participantId: this.#participantId,
      source: state.source,
      enabled: state.enabled,
      publicationId: state.providerPublicationId,
    }));
  }
  #projectRemotePublications(): readonly MediaPublication[] {
    return [...this.#remoteTracks.values()].map(({ participantId, source, publicationId }) => ({ participantId, source, publicationId, enabled: true }));
  }
  #publishCallStats(): void {
    if (this.#snapshot.callStats !== this.#callStats.recent()) this.#publishSnapshot();
  }
  #publishSnapshot(phase = this.#snapshot.connection.phase, failure = this.#snapshot.failure): void {
    const next = freezeSnapshot({
      connection: {
        phase,
        peerConnectionState: this.#connection.connectionState,
        iceConnectionState: this.#connection.iceConnectionState,
      },
      cursor: this.#cursor ? { incarnation: this.#cursor.incarnation, sequence: this.#cursor.sequence } : null,
      localTracks: this.#locals.tracks.size
        ? [...this.#locals.tracks.values()].map((state) =>
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
      remoteDelivery: this.#delivery.deliveries,
      callStats: this.#callStats.recent(),
      failure,
    });
    if (snapshotEqual(this.#snapshot, next)) return;
    this.#snapshot = next;
    for (const listener of this.#snapshotListeners) this.#invokeListener(listener);
  }
  #setFailure(error: unknown, fallback: SFUFailureCode): void {
    const code = error instanceof SFUError ? error.code : fallback;
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
    if (generation !== this.#generation || this.#stopped) throw new SFUError("Stale media connection", "stale_generation");
  }
  #requireActive(): void {
    if (this.#stopped) throw new SFUError("SFU client stopped", "media_failed");
  }
  #requireTransport(): SFUSignalingTransport {
    if (!this.#transport) throw new SFUError("SFU signaling unavailable", "signaling_failed");
    return this.#transport;
  }
}
type LocalOfferOrigin = Exclude<SFULocalOfferDiagnostic["origin"], "outside_sdk">;
