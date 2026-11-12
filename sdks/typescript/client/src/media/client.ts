import type { ClientMediaPlane, LocalPublicationRetirementCause, MediaConnectionReplacementCause, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaPublicationSource } from "./plane";
import { ReceiveStallRecovery } from "./receive-stall";
import { AudioReceiveHealth } from "./audio-receive-health";
import { CameraUplinkPolicy, cameraUplinkBitrate } from "./camera-uplink";
import { ViewerLayerSelector, type ViewerLayerChange } from "./viewer-layer";
import { UNREPORTED_TILE_WAIT_MS, VideoTileSubscriptions } from "./video-tile-visibility";
import { subscribeSnapshot } from "./observers";
import { resolveMediaTarget } from "./target";
import { comparePublicationCursor, parseCloudflareSFUPublicationID, publicationKey, requireDescription, requireSFUDescription, validatePublicationSnapshot, waitFor } from "./tracks";
import { matchRemotePullTracks } from "./remote-track-response";
import { createCallStatsCollector } from "./call-stats";
import { SubscriptionDelivery, type DeliveredVideo } from "./subscription-delivery";
import { CloudflareSFUError } from "./types";
import { iceServersFor } from "./ice-servers";
import { classifyMediaFailure } from "./failure-diagnostics";
import type {
  CloudflareSFUBootstrap,
  CloudflareSFUClientOptions,
  CloudflareSFUFailureCode,
  CloudflareSFULocalOfferDiagnostic,
  CloudflareSFULocalTrack,
  CloudflareSFUPublication,
  CloudflareSFUPublicationSnapshot,
  CloudflareSFURemoteTrack,
  CloudflareSFURestartOptions,
  CloudflareSFUSignalingTransport,
  CloudflareSFUSnapshot,
  CloudflareSFUTrackRequest,
  CloudflareSFUTracksResponse,
  SFUMediaCapabilities,
} from "./types";
import type { PublicationCursor } from "./tracks";
import { expectedOfferAddition, measureOffer, shouldReplaceForOfferSize } from "./offer-size";
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
  state: LocalTrackState;
  transceiver: RTCRtpTransceiver;
  readonly trackName: string;
  readonly connection: RTCPeerConnection;
  readonly connectionId: string;
  detachedAt: number | null;
  lifecycle: { kind: "pending" } | { kind: "confirmed"; handle: LocalPublicationHandle } | { kind: "held"; handle: LocalPublicationHandle } | { kind: "retiring"; handle: LocalPublicationHandle | null; detached: boolean; cause: LocalPublicationRetirementCause } | { kind: "retired" };
};
type LocalPublicationHandle = { readonly publicationId: string; readonly mid: string };
type IceRestart = { readonly connection: RTCPeerConnection; readonly connectionEpoch: number; state: "running" | "succeeded" | "failed" };
type ConnectionObservation = ReturnType<typeof observeConnectionState>;
type LocalRecovery = {
  readonly state: LocalTrackState;
  readonly deadPublicationId: string | null;
  relist: boolean;
  retiring: boolean;
  attempt: number;
  timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  running: boolean;
};
const EMPTY_LOCAL: readonly CloudflareSFULocalTrack[] = Object.freeze([]);
const EMPTY_REMOTE: readonly CloudflareSFURemoteTrack[] = Object.freeze([]);
const EMPTY_RECEIVE_STALLS = Object.freeze([]);
type RemoteTrackEntry = readonly [string, CloudflareSFURemoteTrack];
const NO_CAPABILITIES: SFUMediaCapabilities = Object.freeze({ serverLayerAdaptation: false, subscriptionState: false, iceRestart: false, pullPublished: false, unifiedSignaling: false, muteInPlace: false, keepsIdleSession: false });
const INVALID_PUBLICATION_SIGNATURE = "\u0000invalid";
const CONNECTION_TIMEOUT_MS = 8000;
const RECOVERY_BACKOFF_MS = [1000, 2000, 4000, 5000] as const;
const RECOVERY_HEALTHY_RESET_MS = 10_000;
// A publish rejected on a connection that is not up replaces it at most this many times, after these delays.
const DEAD_CONNECTION_REPLACEMENT_DELAYS_MS = [0, 1000] as const;
const DEAD_SESSION_STATUSES: ReadonlySet<number | undefined> = new Set([404, 406, 410]);
const NEGOTIATION_TIMEOUT_MS = 35000;
const TRANSIENT_PULL_RETRY_MS = [500, 1000, 2000];
const RECEIVER_RETIREMENT_ATTEMPTS = 3;
const RECEIVER_RETIREMENT_LIMIT = 64;
// The SFU rejects a close that names more tracks than this.
const OFFER_REPLACEMENT_COOLDOWN_MS = 60_000;
const TRACKS_PER_REQUEST = 16;
const LONG_PULL_DEFERRAL_MS = 15_000;
// A sender's Sync off can reach a receiver before the sender's SFU close does, so the first listing still names the source.
// The listing then needs a quick re-read, not the idle poll, to drop the track the viewer sees as a frozen tile.
const SYNC_OFF_REPOLL_MS = [150, 300, 600, 1200, 2400, 4800] as const;
const PEER_OPERATION_TIMEOUT_MS = 8000;
// An in-place ICE restart must reconnect within this budget, or the session is replaced.
const ICE_RESTART_BUDGET_MS = 8000;
// A path that stays disconnected this long restarts ICE before the browser declares it failed.
const ICE_DISCONNECTED_RESTART_MS = 2000;
const ICE_RESTART_FAILURE = Object.freeze({ code: "ice_connection_failed", recoverable: true } as const);
const VIEWER_LAYER_BATCH_SIZE = 16;
// Adaptation uses at most 12 of the participant's 60 call-control writes/minute.
const VIEWER_LAYER_UPDATE_INTERVAL_MS = 5000;
// Cloudflare expires tracks after 30 seconds without RTP. Leave time for the
// resume operation rather than trusting Chalk's registry as provider liveness.
const CAPTURE_REUSE_WINDOW_MS = 20_000;
export class CloudflareSFUClient implements ClientMediaPlane {
  readonly #localListeners = new Set<(publications: readonly MediaPublication[]) => void>();
  readonly #onError: CloudflareSFUClientOptions["onError"];
  readonly #onDiagnostic: CloudflareSFUClientOptions["onDiagnostic"];
  readonly #onReceiveHealth: CloudflareSFUClientOptions["onReceiveHealth"];
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
  readonly #localRecoveries = new Map<MediaPublicationSource, LocalRecovery>();
  readonly #recentRecoveries = new Map<MediaPublicationSource, { count: number; healthySince: number }>();
  readonly #remoteTracks = new Map<string, CloudflareSFURemoteTrack>();
  #bootstrap: CloudflareSFUBootstrap;
  #connection: RTCPeerConnection;
  #disposeConnectionObservation: (() => void) | undefined;
  #connectionEpoch = 0;
  #retiredLocalConnection: RTCPeerConnection | null = null;
  #retiredLocalCause: LocalPublicationRetirementCause = "forced_pause";
  #replacementCause: MediaConnectionReplacementCause | undefined;
  #replacement: { readonly generation: number; readonly promise: Promise<void> } | null = null;
  #cursor: PublicationCursor | null = null;
  // The join pulls the room's audio with its first poll, once per media client; later polls list as before.
  #pullPublishedTried = false;
  #remotePullIncomplete = false;
  readonly #remotePullRetries = new Map<string, { readonly retryAfter: number; readonly failures: number; readonly receiveStalled?: boolean }>();
  readonly #receiveProgress = new ReceiveStallRecovery();
  readonly #receiveHealth: AudioReceiveHealth;
  readonly #viewerLayerPending = new Map<string, ViewerLayerChange>();
  readonly #delivery = new SubscriptionDelivery();
  // Off-screen videos this client paused in place. They keep their receiver, MID and track.
  readonly #viewerPaused = new Set<string>();
  // Advertised videos the tile policy leaves out of the last poll: hidden, off screen or in a hidden page.
  #hiddenVideos = 0;
  // Dropped remote tracks whose receive m-line is not closed yet, with the failed closes so far.
  readonly #unretiredReceivers = new Map<CloudflareSFURemoteTrack, number>();
  // A stopped transceiver keeps its mid until the next negotiation, so a later retirement would find it and close it a second time.
  readonly #closedReceiverTracks = new WeakSet<MediaStreamTrack>();
  // Layer and pause updates reach the SFU in the order the client decided them, so a layer update cannot resume a pause.
  #trackUpdates: Promise<unknown> = Promise.resolve();
  // The unmute of a parked track that started before Sync answered, one per source. It never rejects.
  readonly #headStarts = new Map<MediaPublicationSource, Promise<void>>();
  readonly #resumesInFlight = new WeakMap<OwnedLocalPublication, Promise<unknown>>();
  // The publication each source's head start resumed, until that source's enable has used it.
  readonly #resumedAhead = new Map<MediaPublicationSource, OwnedLocalPublication>();
  #viewerLayerUpdating = false;
  #viewerLayerUpdateAt = Number.NEGATIVE_INFINITY;
  #remoteParticipantIds: ReadonlySet<string> | null = null;
  // Bumped when the remote participants or tile visibility change, so a reconcile that raced the change pulls again.
  #remotePullInputRevision = 0;
  readonly #subscribedPublicationIds = new Set<string>();
  #syncPublications: readonly MediaPublication[] = [];
  readonly #videoTiles: VideoTileSubscriptions;
  readonly #stopObservingVideoTiles: () => void;
  #videoTileWake: ReturnType<typeof globalThis.setTimeout> | undefined;
  // A tile change must reach the provider even while the tab is hidden, where routine polls pause.
  #videoTilesChanged = false;
  #generation = 0;
  #negotiatedGeneration: number | null = null;
  #replacementAttemptedGeneration: number | null = null;
  #offerBudgetCooldownUntil = 0;
  #remoteRecoveryGeneration: number | null = null;
  #polling = false;
  #pollAfterCurrent = false;
  #pollFailures = 0;
  #pollFailedPull = false;
  #syncOffRepolls = 0;
  #pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #sdpTail: Promise<void> = Promise.resolve();
  // The current connection's in-place ICE restart. One that failed leaves only session replacement.
  #iceRestart: IceRestart | null = null;
  // The SDK call that started the pending local offer. Null once an answer or a rollback ends it.
  #localOffer: { readonly connection: RTCPeerConnection; readonly origin: LocalOfferOrigin; readonly at: number } | null = null;
  #retirement: Promise<void> = Promise.resolve();
  #snapshot: CloudflareSFUSnapshot;
  #started = false;
  // The epoch of the last connection that went live; a pull that times out on any other one never connected.
  #connectedEpoch = -1;
  #receivingInitial = false;
  #stopped = false;
  #transport: CloudflareSFUSignalingTransport | undefined;
  readonly #callStats = createCallStatsCollector({ upload: async (stats) => this.#transport?.uploadCallStats?.(stats, false) });
  constructor(options: CloudflareSFUClientOptions) {
    validateClientOptions(options);
    this.#participantId = options.participantId;
    this.#bootstrap = options.bootstrap;
    this.#transport = options.transport;
    this.#pollIntervalMs = options.pollIntervalMs ?? 15000;
    this.#videoTiles = new VideoTileSubscriptions(pageIsHidden(), Date.now(), options.unreportedVideoTileWaitMs ?? UNREPORTED_TILE_WAIT_MS);
    this.#replaceMediaConnection = options.replaceMediaConnection;
    this.#onError = options.onError;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onReceiveHealth = options.onReceiveHealth;
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
  localPublicationWithdrawn(publicationId: string): void {
    const owned = [...this.#ownedPublications].find((publication) => publication.lifecycle.kind === "confirmed" && publication.lifecycle.handle.publicationId === publicationId && publication.state.providerPublicationId === publicationId);
    const state = owned?.state;
    if (!state || !state.desiredEnabled || this.#localTracks.get(state.source) !== state) return;
    this.#beginLocalRecovery(state, publicationId, false);
  }
  remoteParticipantsChanged(participantIds: readonly string[]): void {
    this.#remoteParticipantIds = new Set(participantIds);
    this.#remotePullInputRevision++;
    this.#remotePullIncomplete = true;
    this.remotePublicationsChanged();
  }
  remotePublicationsChanged(publications?: readonly MediaPublication[], projectionState: "available" | "unavailable" = "available"): void {
    this.#syncOffRepolls = 0;
    if (projectionState === "unavailable") this.#syncPublications = [];
    else if (publications) this.#syncPublications = publications;
    if (projectionState === "unavailable") this.#receiveHealth.projection([]);
    else if (publications) this.#receiveHealth.projection(publications);
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
    const reusable = [...this.#ownedPublications].find((item) => item.state.source === source && item.connection === this.#connection && (item.lifecycle.kind === "confirmed" || item.lifecycle.kind === "held"));
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
        if (this.#localTracks.get("screen") === state) this.#invokeListener(() => this.#onScreenEnded?.());
      };
      track.addEventListener("ended", state.endedListener);
    }
    this.#dropLocalRecovery(source);
    this.#localTracks.set(source, state);
    this.#publishSnapshot();
    this.#emitLocal();
  }
  async clearPreparedLocalTrack(source: MediaPublicationSource, options: { readonly stopTrack?: boolean } = {}): Promise<void> {
    this.#dropLocalRecovery(source);
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
    this.#dropLocalRecovery(source);
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
    this.#receiveHealth.start();
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
      await this.#pullSyncAdvertisedPublications(generation);
      const authoritative = await this.#listOrPullPublications(transport, generation);
      this.#requireGeneration(generation);
      this.#republishUnlistedLocalPublications(authoritative);
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
  async #listOrPullPublications(transport: CloudflareSFUSignalingTransport, generation: number): Promise<CloudflareSFUPublicationSnapshot> {
    const pull = transport.pullPublishedAudio?.bind(transport);
    if (!pull || !this.#capabilities().pullPublished || this.#pullPublishedTried || this.#cursor !== null || this.#remoteTracks.size > 0) {
      return this.#signal(() => transport.listPublications());
    }
    this.#pullPublishedTried = true;
    try {
      return await this.#pullPublishedAudio(pull, generation);
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
    let pulled: readonly CloudflareSFURemoteTrack[] | null;
    try {
      pulled = await this.#pull(pending, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#stopped) throw error;
      // The listing owns retry and recovery; do not let this attempt's backoff delay it.
      for (const publication of pending) this.#remotePullRetries.delete(publication.publicationId);
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
  async #pendingSyncAdvertisedPulls(): Promise<CloudflareSFUPublication[]> {
    if (!this.#started || !this.#capabilities().subscriptionState) return [];
    const named = this.#syncPublications.flatMap(({ participantId, source, enabled, publicationId }) => (enabled && publicationId !== null ? [{ participantId, source, publicationId }] : []));
    const advertised = desiredRemotePublications(
      named.filter((publication) => this.#canSubscribeToRemotePublication(publication)),
      this.#participantId,
    );
    const fresh = new Map([...this.#visibleRemotePublications(advertised)].filter(([key, publication]) => this.#remoteTracks.get(key)?.publicationId !== publication.publicationId));
    const pending = this.#pendingRemotePulls(fresh);
    // The listing that follows owns the replacement (#pullWithRecovery); an early pull would only add a section to an offer that is already too large.
    return pending.length > 0 && (await this.#hasSpentOfferBudget(pending, false, false)) ? [] : pending;
  }
  #commitEarlyPulledTracks(pulled: readonly CloudflareSFURemoteTrack[]): void {
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
  #republishUnlistedLocalPublications(authoritative: CloudflareSFUPublicationSnapshot): void {
    const unlisted = [...this.#localTracks.values()].filter((state) => state.enabled && state.desiredEnabled && state.providerPublicationId !== null && !authoritative.publications.some((publication) => publication.publicationId === state.providerPublicationId));
    for (const state of unlisted) this.#beginLocalRecovery(state, state.providerPublicationId, true);
  }
  #beginLocalRecovery(state: LocalTrackState, deadPublicationId: string | null, relist: boolean): void {
    if (!this.#canBeginLocalRecovery(state)) return;
    const now = Date.now();
    const delayMs = this.#recoveryStartDelay(state.source, now);
    const recovery: LocalRecovery = { state, deadPublicationId, relist, retiring: false, attempt: 0, timer: undefined, running: false };
    this.#localRecoveries.set(state.source, recovery);
    this.#scheduleLocalRecovery(recovery, delayMs);
  }
  #canBeginLocalRecovery(state: LocalTrackState): boolean {
    return state.enabled && state.desiredEnabled && !this.#stopped && !this.#locallyPausedSources.has(state.source) && !this.#localRecoveries.has(state.source);
  }
  #recoveryStartDelay(source: MediaPublicationSource, now: number): number {
    const recent = this.#recentRecoveries.get(source);
    if (!recent || now - recent.healthySince >= RECOVERY_HEALTHY_RESET_MS) {
      this.#recentRecoveries.set(source, { count: 0, healthySince: now });
      return 0;
    }
    this.#recentRecoveries.set(source, { count: recent.count + 1, healthySince: now });
    return recoveryBackoffMs(recent.count);
  }
  #scheduleLocalRecovery(recovery: LocalRecovery, delayMs: number): void {
    recovery.timer = globalThis.setTimeout(() => {
      recovery.timer = undefined;
      if (this.#localRecoveries.get(recovery.state.source) !== recovery) return;
      void this.#runLocalRecovery(recovery.state.source);
    }, delayMs);
  }
  #canRecover(recovery: LocalRecovery): boolean {
    return this.#localRecoveries.get(recovery.state.source) === recovery && !this.#stopped && !this.#locallyPausedSources.has(recovery.state.source) && this.#localTracks.get(recovery.state.source) === recovery.state;
  }
  async #runLocalRecovery(source: MediaPublicationSource): Promise<void> {
    const recovery = this.#localRecoveries.get(source);
    if (!recovery || recovery.running || this.#discardUnrecoverableIntent(recovery)) return;
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
    if (!(await this.#relistLocalRecoveryIfNeeded(recovery)) || !this.#canContinueLocalRecovery(recovery)) {
      this.#dropLocalRecovery(recovery.state.source, recovery);
      return;
    }
    this.#retireDeadLocalPublication(recovery);
    if (await this.#retireLocalRecoveryIfNeeded(recovery)) return;
    const published = await this.#enablePreparedTrack(recovery.state);
    if (this.#discardUnrecoverableIntent(recovery)) return;
    if (!this.#settleLocalRecovery(recovery, published)) this.#scheduleLocalRecoveryRetry(recovery);
  }
  async #relistLocalRecoveryIfNeeded(recovery: LocalRecovery): Promise<boolean> {
    const { state, deadPublicationId } = recovery;
    if (!recovery.relist || deadPublicationId === null) return true;
    const authoritative = await this.#signal(() => this.#requireTransport().listPublications());
    if (!this.#canRecover(recovery) || state.providerPublicationId !== deadPublicationId || !state.desiredEnabled) return false;
    if (authoritative.publications.some((publication) => publication.publicationId === deadPublicationId)) {
      this.#dropLocalRecovery(state.source, recovery);
      return false;
    }
    recovery.relist = false;
    return true;
  }
  #canContinueLocalRecovery(recovery: LocalRecovery): boolean {
    if (!this.#canRecover(recovery) || recovery.retiring) return this.#canRecover(recovery);
    if (recovery.deadPublicationId !== null && recovery.state.providerPublicationId !== recovery.deadPublicationId) return false;
    return recovery.state.desiredEnabled;
  }
  #retireDeadLocalPublication(recovery: LocalRecovery): void {
    if (recovery.retiring || recovery.deadPublicationId === null || recovery.state.providerPublicationId !== recovery.deadPublicationId) return;
    recovery.retiring = true;
    this.#pauseLocalSource(recovery.state.source, "discovery_absent", { group: false });
  }
  async #retireLocalRecoveryIfNeeded(recovery: LocalRecovery): Promise<boolean> {
    if (!this.#hasRetiringLocalPublications(recovery.state.source)) return false;
    await this.#retireLocalRecoveryPublications(recovery.state.source);
    return this.#discardUnrecoverableIntent(recovery);
  }
  async #retryLocalRecovery(recovery: LocalRecovery, error: unknown): Promise<void> {
    if (this.#discardUnrecoverableIntent(recovery)) return;
    this.#reportLocalRecoveryError(error);
    await this.#replaceConnectionForLocalRecovery(error);
    this.#scheduleLocalRecoveryRetry(recovery);
  }
  #discardUnrecoverableIntent(recovery: LocalRecovery): boolean {
    if (this.#canRecover(recovery)) return false;
    this.#dropLocalRecovery(recovery.state.source, recovery);
    return true;
  }
  #settleLocalRecovery(recovery: LocalRecovery, published: boolean): boolean {
    const source = recovery.state.source;
    if (!published && this.#locallyPausedSources.has(source)) {
      this.#dropLocalRecovery(source, recovery);
      return true;
    }
    const publicationId = recovery.state.providerPublicationId;
    if (!published || publicationId === null || publicationId === recovery.deadPublicationId) return false;
    const recent = this.#recentRecoveries.get(source);
    if (recent) this.#recentRecoveries.set(source, { ...recent, healthySince: Date.now() });
    this.#dropLocalRecovery(source, recovery);
    return true;
  }
  #reportLocalRecoveryError(error: unknown): void {
    if (error instanceof AggregateError) {
      for (const cause of error.errors) this.#reportError(cause);
      return;
    }
    this.#reportError(error);
  }
  async #replaceConnectionForLocalRecovery(error: unknown): Promise<void> {
    const failures: readonly unknown[] = error instanceof AggregateError ? error.errors : [error];
    if (!this.#replaceMediaConnection || failures.length === 0 || !failures.every((failure) => this.#isRetryableConnectionFailure(failure))) return;
    const generation = this.#generation;
    try {
      await this.#replaceMediaConnectionForRecovery(generation, "local_signaling_failure");
    } catch {
      return;
    }
    try {
      await this.#republishPreparedTracksAfterRecovery(generation);
    } catch (republishError) {
      this.#reportLocalRecoveryError(republishError);
    }
  }
  #scheduleLocalRecoveryRetry(recovery: LocalRecovery): void {
    if (!this.#canRecover(recovery)) {
      this.#dropLocalRecovery(recovery.state.source, recovery);
      return;
    }
    this.#scheduleLocalRecovery(recovery, recoveryBackoffMs(recovery.attempt++));
  }
  #hasRetiringLocalPublications(source: MediaPublicationSource): boolean {
    return [...this.#ownedPublications].some((publication) => publication.state.source === source && publication.lifecycle.kind === "retiring" && publication.lifecycle.handle !== null);
  }
  #retireLocalRecoveryPublications(source: MediaPublicationSource): Promise<void> {
    return this.#retireOwnedPublications(() => {}, { sources: [source], goneIsComplete: true });
  }
  #dropLocalRecovery(source: MediaPublicationSource, expected?: LocalRecovery): void {
    for (const item of localSourceGroup(source)) {
      const recovery = this.#localRecoveries.get(item);
      if (!recovery || (expected && recovery !== expected)) continue;
      if (recovery.timer !== undefined) globalThis.clearTimeout(recovery.timer);
      this.#localRecoveries.delete(item);
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
  /**
   * Runs what an enable can do while Sync still decides it, so the grant does not wait behind that round trip.
   * A parked track (mute in place) is resumed on the SFU at once. The node's source lease authorizes what it
   * forwards: a closed lease forwards nothing, and a role change, a removal and the end of the Episode revoke it.
   * Until the SDK sees Sync's result, a resumed track may forward under a standing lease; on a refusal the SDK
   * closes the publication at once. Otherwise this swaps a connection that never carried media for a fresh one,
   * adds no transceiver and sends no offer. A fresh publish never goes ahead, because a new publication needs the grant.
   * `setLocalPublicationTarget` redoes whatever this left undone, so a rejection is safe to ignore.
   */
  async prepareLocalPublicationTarget(target: MediaPlaneTarget): Promise<void> {
    if (!target.enabled || this.#locallyPausedSources.has(target.source)) return;
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind !== "state") return;
    if (this.#heldPublication(target.source) && !this.#replacement) {
      const headStart = (this.#headStarts.get(target.source) ?? Promise.resolve()).then(() => this.#resumeHeldAheadOfGrant(resolved.value));
      this.#headStarts.set(target.source, headStart);
      void headStart.then(() => {
        if (this.#headStarts.get(target.source) === headStart) this.#headStarts.delete(target.source);
      });
      return headStart;
    }
    const generation = this.#generation;
    const attemptedBefore = this.#replacementAttemptedGeneration === generation;
    try {
      await this.#serializeSDP(async () => {
        // A retired bundled sender rebuilds the connection and republishes other sources inside the publish itself.
        if (this.#retiredLocalConnection === this.#connection && this.#replaceMediaConnection) return;
        await this.#replaceDormantConnectionBeforeNegotiation(generation);
      });
    } catch (error) {
      // The grant-gated publish owns the replacement now, so its own attempt must still run and report.
      if (!attemptedBefore && this.#replacementAttemptedGeneration === generation) this.#replacementAttemptedGeneration = null;
      throw error;
    }
  }
  async setLocalPublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    if (!target.enabled) return this.#pausePublicationTarget(target);
    await this.#headStarts.get(target.source);
    const result = await this.#enablePublicationTarget(target).finally(() => this.#resumedAhead.delete(target.source));
    if (target.source !== "screen" || !this.#localTracks.has("screen_audio") || (result.outcome !== "confirmed" && result.outcome !== "satisfied")) return result;
    return this.#enablePublicationTarget({ ...target, source: "screen_audio" });
  }
  async #pausePublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    this.#dropLocalRecovery(target.source);
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind === "result" && resolved.result.outcome !== "satisfied") return resolved.result;
    const outcome = resolved.kind === "state" && resolved.value.enabled ? "confirmed" : "satisfied";
    this.#dropLocalRecovery(target.source);
    if (target.source !== "screen" && this.#locallyPausedSources.get(target.source) === "capture_cleanup") {
      // Sync acknowledges unavailable capture without revoking its retained
      // publication. Explicit Off first records user_pause and still retires.
      await this.pauseLocalCapture(target.source);
      return { outcome, errorCode: null };
    }
    // Sync's off acknowledgment reaches a publication the user's mute already parked; closing it would undo the park.
    if (this.#heldPublication(target.source)) return { outcome, errorCode: null };
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
    if (this.#locallyPausedSources.has(state.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    if (!state.desiredEnabled) return { outcome: "satisfied", errorCode: null };
    state.track.enabled = true;
    return null;
  }
  #postReplacementEnableOutcome(state: LocalTrackState, generation: number, replacement: { readonly generation: number; readonly promise: Promise<void> } | null): MediaPlaneResult | null {
    if (this.#locallyPausedSources.has(state.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    if (replacement?.generation === generation && !state.desiredEnabled) return { outcome: "satisfied", errorCode: null };
    if (state.enabled) {
      state.track.enabled = true;
      return { outcome: "satisfied", errorCode: null };
    }
    return null;
  }
  async #enablePublicationTarget(target: Omit<MediaPlaneTarget, "source"> & { readonly source: MediaPublicationSource }): Promise<MediaPlaneResult> {
    const generation = this.#generation;
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind === "result") return resolved.result;
    const state = resolved.value;
    if (this.#locallyPausedSources.has(target.source)) return { outcome: "terminal_failure", errorCode: "local_source_paused" };
    try {
      const replacement = this.#replacement;
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
    this.#dropLocalRecovery(source);
    this.#locallyPausedSources.set(source, "capture_cleanup");
    const state = this.#localTracks.get(source);
    if (state) await this.#disablePreparedTrack(state);
  }
  setLocalSourceIntent(source: MediaPublicationSource, enabled: boolean, cause: LocalPublicationRetirementCause = "forced_pause"): Promise<void> {
    const sources = localSourceGroup(source);
    if (!enabled) this.#dropLocalRecovery(source);
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
    // The publication list leaves out a parked publication, so absence there is not loss.
    if ((this.#heldPublication(state.source) ?? this.#resumedAheadPublication(state))?.handle.publicationId === publicationId) return;
    const authoritative = await this.#signal(() => this.#requireTransport().listPublications());
    if (authoritative.publications.some((publication) => publication.publicationId === publicationId)) return;
    if (state.providerPublicationId !== publicationId || this.#localRecoveries.has(state.source)) return;
    if (state.enabled && state.desiredEnabled) {
      this.#beginLocalRecovery(state, publicationId, true);
      return;
    }
    this.#pauseLocalSource(state.source, "discovery_absent");
    await this.#retireOwnedPublications(undefined, { goneIsComplete: true });
  }
  #pauseLocalSource(source: MediaPublicationSource, cause: LocalPublicationRetirementCause = "forced_pause", options: { readonly group?: boolean } = {}): void {
    const sources = options.group === false ? [source] : localSourceGroup(source);
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
  #retireOwnedPublications(reportFailure: (error: unknown) => void = this.#reportError.bind(this), options?: { readonly sources?: readonly MediaPublicationSource[]; readonly goneIsComplete?: boolean }): Promise<void> {
    const publications = this.#retiringOwnedPublications(options?.sources);
    const retirement = this.#runOwnedRetirement(publications, reportFailure, options?.goneIsComplete === true);
    // Observe shutdown and intent callers even when they do not await cleanup.
    void retirement.catch(() => {});
    return (this.#retirement = retirement);
  }
  #retiringOwnedPublications(sources?: readonly MediaPublicationSource[]): OwnedLocalPublication[] {
    return [...this.#ownedPublications].filter((item) => item.lifecycle.kind === "retiring" && item.lifecycle.handle && (!sources || sources.includes(item.state.source)));
  }
  async #runOwnedRetirement(publications: readonly OwnedLocalPublication[], reportFailure: (error: unknown) => void, goneIsComplete: boolean): Promise<void> {
    const errors: unknown[] = [];
    for (const publication of publications) {
      try {
        await this.#serializeSDP(() => this.#closeOwnedPublication(publication), true);
      } catch (error) {
        if (goneIsComplete && this.#retireGonePublication(publication, error)) continue;
        errors.push(error);
        if (!this.#stopped) reportFailure(error);
      }
    }
    if (this.#stopped && this.#ownedPublications.size === 0) this.#transport = undefined;
    if (errors.length) throw new AggregateError(errors, "Media retirement failed");
  }
  #retireGonePublication(publication: OwnedLocalPublication, error: unknown): boolean {
    if (!isGonePublicationFailure(error)) return false;
    publication.lifecycle = { kind: "retired" };
    this.#ownedPublications.delete(publication);
    return true;
  }
  #markPublicationRetiring(publication: OwnedLocalPublication, cause: LocalPublicationRetirementCause = "publish_failure"): void {
    const phase = publication.lifecycle;
    // A parked publication is already what a user pause wants.
    if (phase.kind === "held" && cause === "user_pause") return;
    if (phase.kind === "pending" || phase.kind === "confirmed" || phase.kind === "held") {
      publication.lifecycle = { kind: "retiring", handle: phase.kind === "pending" ? null : phase.handle, detached: false, cause };
    }
  }
  #carriesBundleTransport(publication: OwnedLocalPublication): boolean {
    const bundleTag = bundleTagOf(publication.connection);
    return !bundleTag || (publication.transceiver.mid !== null && publication.transceiver.mid === bundleTag);
  }
  #shouldKeepBundleTransportOnUserPause(publication: OwnedLocalPublication, closed: boolean): boolean {
    const { lifecycle, state } = publication;
    return !closed && lifecycle.kind === "retiring" && lifecycle.cause === "user_pause" && (state.source === "microphone" || state.source === "camera") && this.#carriesBundleTransport(publication);
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
    this.#ownedPublications.delete(publication);
  }
  #markBundledTransportRetiring(publication: OwnedLocalPublication): void {
    // Real SFU probe (2026-10-30): closing BUNDLE MID 0 caused 410
    // session_error; closing MID 1 kept MID 0 and the session working.
    // Follow the negotiated BUNDLE tag, since the first sender can be video.
    // Missing bundle information retains the conservative rebuild behavior.
    if (this.#carriesBundleTransport(publication)) {
      if (this.#retiredLocalConnection === publication.connection) return;
      this.#retiredLocalConnection = publication.connection;
      if (publication.lifecycle.kind === "retiring") this.#retiredLocalCause = publication.lifecycle.cause;
    }
  }
  #canHoldOnUserPause(publication: OwnedLocalPublication, phase: Extract<OwnedLocalPublication["lifecycle"], { kind: "retiring" }>): boolean {
    const { source } = publication.state;
    return (
      phase.cause === "user_pause" &&
      (source === "microphone" || source === "camera") &&
      this.#capabilities().muteInPlace &&
      this.#transport?.updateTracks !== undefined &&
      publication.connection === this.#connection &&
      publication.connectionId === this.#bootstrap.connectionId &&
      !connectionIsClosed(publication.connection)
    );
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
  #heldPublication(source: MediaPublicationSource): { readonly publication: OwnedLocalPublication; readonly handle: LocalPublicationHandle } | undefined {
    for (const publication of this.#ownedPublications) {
      const { lifecycle } = publication;
      if (lifecycle.kind === "held" && publication.state.source === source && publication.connection === this.#connection) return { publication, handle: lifecycle.handle };
    }
    return undefined;
  }
  // A user mute leaves the SDP alone: parked on the SFU when it can hold, else closed over the kept BUNDLE transport.
  async #retireWithoutRenegotiation(publication: OwnedLocalPublication, phase: Extract<OwnedLocalPublication["lifecycle"], { kind: "retiring" }>, handle: LocalPublicationHandle): Promise<boolean> {
    if (this.#canHoldOnUserPause(publication, phase) && (await this.#holdOwnedPublication(publication, phase, handle))) return true;
    // The close offer carries every closed section. Past the size budget it could reach the node's cap, so close without SDP and let the next pull or publish replace the connection.
    const keep = this.#shouldKeepBundleTransportOnUserPause(publication, connectionIsClosed(publication.connection)) || (!connectionIsClosed(publication.connection) && shouldReplaceForOfferSize(await this.#measureLocalOffer(publication.connection)));
    if (keep) await this.#closeOwnedPublicationKeepingBundleTransport(publication, phase, handle);
    return keep;
  }
  async #closeOwnedPublication(publication: OwnedLocalPublication): Promise<void> {
    // A resume still in flight must reach the SFU before the close, or the close would be answered by the resume.
    await this.#resumesInFlight.get(publication);
    const phase = publication.lifecycle;
    if (phase.kind !== "retiring" || !phase.handle) return;
    const handle = phase.handle;
    const { connection, connectionId, transceiver, state } = publication;
    try {
      if (await this.#retireWithoutRenegotiation(publication, phase, handle)) return;
      this.#markBundledTransportRetiring(publication);
      let closed = connection.connectionState === "closed";
      if (!phase.detached && !closed) {
        await this.#boundPeerOperation(transceiver.sender.replaceTrack(null));
        closed = connection.connectionState === "closed";
        if (!closed) transceiver.stop();
      }
      phase.detached = true;
      const sessionDescription = closed ? undefined : await this.#createLocalOffer(connection, "close");
      const response = await this.#signal(() => this.#requireTransport().closeTracks({ connectionId, sessionDescription, tracks: [{ ...handle, source: state.source }], force: closed }), { generation: this.#generation, connectionId });
      // The API has committed the disabled observation even if applying SDP fails.
      publication.lifecycle = { kind: "retired" };
      this.#ownedPublications.delete(publication);
      await this.#applyProviderDescriptionIfOpen(response, connection, { generation: this.#generation, connectionId });
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
  observeAudioElement(track: MediaStreamTrack, element: HTMLAudioElement): { played(result: unknown): void; detach(): void } {
    return this.#receiveHealth.observeAudioElement(track, element);
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
    this.#setPhase("recovering", null);
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
    // Retiring publications clears the transport before a pending upload ends, so the closing batch keeps its own reference.
    const transport = this.#transport;
    void this.#callStats.flush(async (stats) => transport?.uploadCallStats?.(stats, true));
    this.#receiveHealth.roster([]);
    this.#receiveHealth.dispose();
    this.#receiveProgress.expect([], this.#participantId);
    for (const source of [...this.#localRecoveries.keys()]) this.#dropLocalRecovery(source);
    this.#recentRecoveries.clear();
    this.#subscribedPublicationIds.clear();
    this.#stopObservingVideoTiles();
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
      const parked = this.#heldPublication(state.source) ?? this.#resumedAheadPublication(state);
      if (parked && !state.transceiver) {
        state.transceiver = parked.publication.transceiver;
        state.providerPublicationId = parked.handle.publicationId;
      }
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
    const held = this.#heldPublication(state.source);
    if (held?.publication.transceiver === transceiver && !(await this.#resumeHeldPublication(held.publication, held.handle, state))) return await this.#republishAfterFailedResume(held.publication, state);
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
  async #resumeHeldPublication(publication: OwnedLocalPublication, handle: LocalPublicationHandle, state: LocalTrackState): Promise<boolean> {
    if (!(await this.#setLocalPublicationHeld(publication, handle, false))) return false;
    publication.lifecycle = { kind: "confirmed", handle };
    publication.state = state;
    publication.detachedAt = null;
    return true;
  }
  // Resumes a parked track on the SFU before Sync answers. It leaves the track's own state (enabled, published ID) to the
  // grant-gated enable, so nothing local shows the source on until Sync has granted it. A failed resume is left to that enable.
  async #resumeHeldAheadOfGrant(state: LocalTrackState): Promise<void> {
    const held = this.#heldPublication(state.source);
    if (!held || this.#locallyPausedSources.has(state.source)) return;
    try {
      state.track.enabled = true;
      await this.#boundPeerOperation(held.publication.transceiver.sender.replaceTrack(state.track));
      if (this.#heldPublication(state.source)?.publication === held.publication && !this.#locallyPausedSources.has(state.source)) {
        const resuming = this.#resumeHeldPublication(held.publication, held.handle, state);
        this.#resumesInFlight.set(held.publication, resuming);
        await resuming;
        if (held.publication.lifecycle.kind === "confirmed") this.#resumedAhead.set(state.source, held.publication);
      }
      const cause = this.#locallyPausedSources.get(state.source);
      if (cause) {
        this.#pauseLocalSource(state.source, cause);
        await this.#retireOwnedPublications();
      }
    } catch {
      // The grant-gated enable redoes the resume and reports its own failure.
    }
  }
  #resumedAheadPublication(state: LocalTrackState): { readonly publication: OwnedLocalPublication; readonly handle: LocalPublicationHandle } | undefined {
    const publication = this.#resumedAhead.get(state.source);
    if (publication?.state !== state || publication.connection !== this.#connection || publication.lifecycle.kind !== "confirmed") return undefined;
    return { publication, handle: publication.lifecycle.handle };
  }
  // The SFU no longer holds the parked track (for example after it lost the session), so publish a new one.
  async #republishAfterFailedResume(publication: OwnedLocalPublication, state: LocalTrackState): Promise<boolean> {
    this.#markPublicationRetiring(publication, "enable_failure");
    state.transceiver = null;
    state.providerPublicationId = null;
    await this.#retireOwnedPublications().catch(() => {});
    await this.#publishPreparedTracks([state], this.#generation);
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
          if (!this.#replaceMediaConnection) throw error;
          if (this.#isRejectedOnDeadConnection(error)) return await this.#publishOnReplacedConnections(states, generation, error);
          if (!this.#isRetryableConnectionFailure(error) || this.#replacementAttemptedGeneration === generation) throw error;
          await this.#replaceMediaConnectionForRecovery(generation, "local_signaling_failure");
          await this.#publishPreparedTracksSerialized(this.#tracksToPublish(states), generation, this.#connection, this.#bootstrap.connectionId);
        }
      });
    } finally {
      // Cleanup reports its own failures; another source cannot revoke this enable.
      await this.#retirement.catch(() => {});
    }
  }
  #tracksToPublish(states: readonly LocalTrackState[]): LocalTrackState[] {
    return [...this.#localTracks.values()].filter((state) => (state.desiredEnabled || states.includes(state)) && state.track.readyState !== "ended");
  }
  // Cloudflare answers an offer on a session that never came up with 406, and later calls on it with 410 or 404.
  #isRejectedOnDeadConnection(error: unknown): boolean {
    return error instanceof CloudflareSFUError && error.code === "signaling_failed" && DEAD_SESSION_STATUSES.has(error.options.status) && !connectionIsLive(this.#connection);
  }
  // The once-per-generation replacement budget protects a connection that was up. A connection that never came up
  // gets its own short budget, so a dead session cannot keep the speaker silent until someone toggles the mic.
  async #publishOnReplacedConnections(states: readonly LocalTrackState[], generation: number, rejection: unknown): Promise<void> {
    let failure = rejection;
    for (const delayMs of DEAD_CONNECTION_REPLACEMENT_DELAYS_MS) {
      if (delayMs > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
      this.#requireGeneration(generation);
      this.#replacementAttemptedGeneration = null;
      await this.#replaceMediaConnectionForRecovery(generation, "local_signaling_failure");
      try {
        await this.#publishPreparedTracksSerialized(this.#tracksToPublish(states), generation, this.#connection, this.#bootstrap.connectionId);
        return;
      } catch (error) {
        if (!this.#isRejectedOnDeadConnection(error)) throw error;
        failure = error;
      }
    }
    throw failure;
  }
  async #prepareConnectionForPublication(states: readonly LocalTrackState[], generation: number): Promise<readonly LocalTrackState[]> {
    if (this.#retiredLocalConnection !== this.#connection || !this.#replaceMediaConnection) {
      await this.#replaceDormantConnectionBeforeNegotiation(generation);
      const additions = states.filter((state) => !state.enabled && state.transceiver === null);
      if (!(await this.#hasSpentOfferBudget(additions, true))) return states;
      await this.#replaceForOfferSize(() => this.#replaceMediaConnectionForRecovery(generation, "section_budget"));
      return this.#tracksToPublish(states);
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
    await this.#applyProviderDescription(response, connection, { generation, connectionId });
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
  async #createLocalOffer(connection: RTCPeerConnection, origin: LocalOfferOrigin, options?: RTCOfferOptions) {
    const description = await createLocalOffer(connection, options);
    this.#localOffer = { connection, origin, at: Date.now() };
    return description;
  }
  // SDP operations are serialized, so a local offer must not outlive its operation. If one does, name its origin.
  #reportPendingLocalOffer(connection: RTCPeerConnection, where: CloudflareSFULocalOfferDiagnostic["where"]): void {
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
  async #reconcileRemotePublications(authoritative: CloudflareSFUPublicationSnapshot, generation: number): Promise<void> {
    await this.#retireDroppedReceivers(generation);
    const cursor = this.#nextRemotePublicationCursor(authoritative);
    if (cursor === null) return;
    const inputRevision = this.#remotePullInputRevision;
    const advertised = this.#desiredRemotePublications(authoritative, cursor);
    this.#receiveHealth.roster(advertised.values());
    this.#pruneRemotePullState(advertised);
    const desired = this.#visibleRemotePublications(advertised);
    // Only the authoritative roster counts: the early-pull pass sees the Sync projection, which is empty while Sync is down.
    this.#hiddenVideos = advertised.size - desired.size;
    this.#pollFailedPull = true;
    const epoch = this.#connectionEpoch;
    const hidden = [...this.#remoteTracks].filter(([key, publication]) => isVideoPublication(publication) && advertised.get(key)?.publicationId === publication.publicationId && !desired.has(key));
    const parked = await this.#pauseVideoInPlace(hidden, generation);
    const unresumed = await this.#resumeVideoInPlace(desired, generation);
    const unclosed = await this.#closeVideo([...hidden.filter((entry) => !parked.includes(entry)), ...unresumed], generation);
    // A hidden tab polls only after a tile change, so a failed close has to ask for the retry itself.
    if (unclosed.length) this.#videoTilesChanged = true;
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
  #announcePulledTracks(pulled: readonly CloudflareSFURemoteTrack[]): void {
    for (const publication of pulled) {
      this.#subscribedPublicationIds.add(publication.publicationId);
      this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    }
    this.#publishSnapshot();
    this.#emitRemote();
  }
  #queueDroppedReceivers(dropped: readonly CloudflareSFURemoteTrack[]): void {
    for (const publication of dropped) {
      if (this.#unretiredReceivers.size >= RECEIVER_RETIREMENT_LIMIT) break;
      this.#unretiredReceivers.set(publication, 0);
    }
  }
  #commitRemoteTracks(desired: ReadonlyMap<string, CloudflareSFUPublication>, pulled: readonly CloudflareSFURemoteTrack[], unclosed: readonly RemoteTrackEntry[], parked: readonly RemoteTrackEntry[], cursor: PublicationCursor, inputRevision: number): readonly CloudflareSFURemoteTrack[] {
    const next = reconcileRemoteTracks(desired, pulled, this.#remoteTracks);
    for (const [key, publication] of [...unclosed, ...parked]) next.set(key, publication);
    const dropped = droppedRemoteTracks(this.#remoteTracks, next);
    this.#remoteTracks.clear();
    for (const [key, publication] of next) this.#remoteTracks.set(key, publication);
    this.#forgetViewerPauses(next.values());
    this.#cursor = cursor;
    // A video paused in place is complete: it is off screen on purpose.
    this.#remotePullIncomplete = inputRevision !== this.#remotePullInputRevision || next.size - parked.length !== desired.size || unclosed.length > 0;
    if (!this.#remotePullIncomplete) this.#remoteRecoveryGeneration = null;
    if (!this.#remotePullIncomplete && this.#hasLiveRemoteTracks()) this.#replacementAttemptedGeneration = null;
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
  #countFailedRetirement(publication: CloudflareSFURemoteTrack): void {
    const failures = (this.#unretiredReceivers.get(publication) ?? 0) + 1;
    if (failures >= RECEIVER_RETIREMENT_ATTEMPTS) this.#unretiredReceivers.delete(publication);
    else this.#unretiredReceivers.set(publication, failures);
  }
  #receiversOf(publications: readonly CloudflareSFURemoteTrack[]) {
    return publications.flatMap((publication) => {
      const transceiver = this.#connection.getTransceivers().find((item) => item.receiver.track === publication.track);
      return transceiver?.mid && !this.#closedReceiverTracks.has(publication.track) ? [{ publication, transceiver, mid: transceiver.mid }] : [];
    });
  }
  #forgetViewerPauses(kept: Iterable<CloudflareSFURemoteTrack>): void {
    const ids = new Set([...kept].map((publication) => publication.publicationId));
    for (const publicationId of this.#viewerPaused) if (!ids.has(publicationId)) this.#viewerPaused.delete(publicationId);
  }
  // A hidden tile keeps its pull backoff and subscription eligibility; only a withdrawn publication loses them.
  #pruneRemotePullState(advertised: ReadonlyMap<string, CloudflareSFUPublication>): void {
    const advertisedIds = new Set([...advertised.values()].map((publication) => publication.publicationId));
    for (const publicationId of this.#remotePullRetries.keys()) {
      if (!advertisedIds.has(publicationId)) this.#remotePullRetries.delete(publicationId);
    }
    for (const publicationId of this.#subscribedPublicationIds) {
      if (!advertisedIds.has(publicationId)) this.#subscribedPublicationIds.delete(publicationId);
    }
  }
  #visibleRemotePublications(advertised: ReadonlyMap<string, CloudflareSFUPublication>): Map<string, CloudflareSFUPublication> {
    const video = [...advertised.values()].filter(isVideoPublication).map((publication) => publication.publicationId);
    const pulled = new Set([...this.#remoteTracks.values()].filter(isVideoPublication).map((publication) => publication.publicationId));
    const { wanted, wakeAt } = this.#videoTiles.select(Date.now(), video, pulled);
    this.#wakeForVideoTiles(wakeAt);
    // A video in picture-in-picture is on screen even while its tab is hidden or its tile is off screen.
    const floating = new Set(pictureInPictureTracks());
    const isFloating = (key: string, publicationId: string) => {
      const track = this.#remoteTracks.get(key);
      return track?.publicationId === publicationId && floating.has(track.track);
    };
    const visible = new Map([...advertised].filter(([key, publication]) => !isVideoPublication(publication) || wanted.has(publication.publicationId) || isFloating(key, publication.publicationId)));
    return visible;
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
  async #resumeVideoInPlace(desired: ReadonlyMap<string, CloudflareSFUPublication>, generation: number): Promise<readonly RemoteTrackEntry[]> {
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
      const mid = this.#connection.getTransceivers().find((transceiver) => transceiver.receiver.track === publication.track)?.mid;
      const { connectionId, trackName } = parseCloudflareSFUPublicationID(publication.publicationId);
      return mid ? [{ publication, request: { location: "remote", mid, sessionId: connectionId, trackName, paused } satisfies CloudflareSFUTrackRequest }] : [];
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
  #updateTracks(tracks: readonly CloudflareSFUTrackRequest[]): Promise<CloudflareSFUTracksResponse> {
    const transport = this.#transport;
    const connectionId = this.#bootstrap.connectionId;
    const owner = { generation: this.#generation, connectionId };
    const update = this.#trackUpdates.then(async () => {
      if (!transport?.updateTracks) throw new CloudflareSFUError("This media plane cannot update tracks in place", "signaling_failed");
      // A replacement issues a token for the new connection, so an update still addressed to the old one is refused (403) by the API.
      // Owning the failure makes the error reporter drop it once the connection has changed; the new connection pulls the state afresh.
      if (this.#bootstrap.connectionId !== connectionId) throw new CloudflareSFUError("Stale media connection", "stale_generation");
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
  #pendingRemotePulls(desired: ReadonlyMap<string, CloudflareSFUPublication>): CloudflareSFUPublication[] {
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
    if (pending.length > 0 && (await this.#hasSpentOfferBudget(pending))) return this.#replaceForOfferSize(() => this.#retryRemotePullOnReplacement([...desired.values()], cursor, generation, "section_budget"));
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
  async #measureLocalOffer(connection: RTCPeerConnection): Promise<ReturnType<typeof measureOffer>> {
    return measureOffer((await connection.createOffer()).sdp ?? "");
  }
  // A safety valve: the media node reuses closed sections, so the offer should not grow this far. When it does, the replacement is logged here and reported to the API as cause section_budget.
  async #hasSpentOfferBudget(tracks: readonly Pick<CloudflareSFUPublication, "source">[], inQueue = false, announce = true): Promise<boolean> {
    if (!this.#replaceMediaConnection) return false;
    const connection = this.#connection;
    const measure = () => this.#measureLocalOffer(connection);
    const size = inQueue ? await measure() : await this.#serializeSDP(measure);
    const additionalBytes = expectedOfferAddition(tracks);
    if (!shouldReplaceForOfferSize(size, { additionalBytes, coolingDown: Date.now() < this.#offerBudgetCooldownUntil })) return false;
    if (announce)
      console.warn(`Chalk media: replacing the media connection because its projected next offer is ${size.bytes + additionalBytes} bytes (${size.reclaimableBytes} in closed or parked sections) and the media node refuses offers over 262144. Closed sections should not pile up; report this.`);
    return true;
  }
  // The size budget is not a recovery from a failure, so it neither needs nor spends the generation's one recovery replacement.
  // Whatever its outcome, the next one waits out the cooldown, except near the node's cap, where there is no cooldown.
  async #replaceForOfferSize<T>(replace: () => Promise<T>): Promise<T> {
    this.#offerBudgetCooldownUntil = Date.now() + OFFER_REPLACEMENT_COOLDOWN_MS;
    this.#replacementAttemptedGeneration = null;
    try {
      return await replace();
    } finally {
      this.#replacementAttemptedGeneration = null;
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
    const pulled = await this.#pullInRequests(retired, generation, (batch) => this.#pullBatch(batch, generation));
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
      await this.#closeReceivers(receivers, generation);
      return stalled;
    });
  }
  async #closeReceivers(receivers: readonly { readonly publication: Pick<CloudflareSFUPublication, "publicationId" | "source">; readonly transceiver: RTCRtpTransceiver; readonly mid: string }[], generation: number): Promise<void> {
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
  #heldRemoteTracks(): ReadonlySet<MediaStreamTrack> {
    return new Set([...this.#remoteTracks.values()].map((publication) => publication.track));
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
    return this.#pullInRequests(eligible, generation, (batch) => this.#pullWithFallback(batch, generation));
  }
  // One request pulls at most 16 tracks. A later batch that fails keeps what the earlier batches already pulled; the roster pulls the rest on the next poll.
  async #pullInRequests(publications: readonly CloudflareSFUPublication[], generation: number, pullBatch: (batch: readonly CloudflareSFUPublication[]) => Promise<readonly CloudflareSFURemoteTrack[]>): Promise<readonly CloudflareSFURemoteTrack[]> {
    const pulled: CloudflareSFURemoteTrack[] = [];
    for (const [index, batch] of [...chunks(publications, TRACKS_PER_REQUEST)].entries()) {
      try {
        pulled.push(...(await pullBatch(batch)));
      } catch (error) {
        this.#requireGeneration(generation);
        // The failed batch is already deferred. Later batches wait out the same error instead of hitting a refusing SFU at once.
        this.#deferRemotePulls(publications.slice((index + 1) * TRACKS_PER_REQUEST), error);
        if (!pulled.length) throw error;
        this.#reportError(error);
        break;
      }
    }
    return pulled;
  }
  async #pullWithFallback(eligible: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[]> {
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
    const transient = transientRemotePull(error);
    for (const publication of publications) {
      const previous = this.#remotePullRetries.get(publication.publicationId);
      const failures = previous?.failures ?? 0;
      const delay = transient ? (TRANSIENT_PULL_RETRY_MS[failures] ?? LONG_PULL_DEFERRAL_MS) : retryableRemotePull(error) ? LONG_PULL_DEFERRAL_MS : Number.POSITIVE_INFINITY;
      this.#remotePullRetries.set(publication.publicationId, { retryAfter: Date.now() + delay, failures: transient ? Math.min(failures + 1, 6) : failures, receiveStalled: previous?.receiveStalled });
    }
  }
  async #pullBatch(publications: readonly CloudflareSFUPublication[], generation: number): Promise<readonly CloudflareSFURemoteTrack[]> {
    if (publications.length === 0) return [];
    this.#receiveHealth.pullRequested(publications.map((publication) => publication.publicationId));
    return this.#serializeSDP(() =>
      this.#negotiateRemotePull(publications, generation, async (connectionId) => {
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
        const response = await this.#signal(() => this.#addTracks({ connectionId, tracks: requested, allowPartialRemoteTracks: true }), { generation, connectionId });
        return { publications, response };
      }),
    );
  }
  // The join's first poll: one request lists the publications and pulls the other Participants' audio. The tracks
  // join the roster before the normal reconcile runs, so it only has the video left to pull.
  async #pullPublishedAudio(pull: NonNullable<CloudflareSFUSignalingTransport["pullPublishedAudio"]>, generation: number): Promise<CloudflareSFUPublicationSnapshot> {
    const listed: { snapshot?: CloudflareSFUPublicationSnapshot } = {};
    const pulled = await this.#serializeSDP(() =>
      this.#negotiateRemotePull([], generation, async (connectionId) => {
        const issued = await this.#signal(() => pull({ connectionId }), { generation, connectionId });
        listed.snapshot = issued.snapshot;
        const audio = issued.snapshot.publications.filter((publication) => publication.participantId !== this.#participantId && !isVideoPublication(publication));
        this.#receiveHealth.pullRequested(audio.map((publication) => publication.publicationId));
        return { publications: audio, response: issued.response };
      }),
    );
    if (!listed.snapshot) throw new CloudflareSFUError("The pull-published request returned no publications", "signaling_failed");
    // The server pulled every listed audio track. The roster still decides which ones this client keeps.
    const kept = pulled.filter((publication) => this.#canSubscribeToRemotePublication(publication));
    const roster = reconcileRemoteTracks(desiredRemotePublications(kept, this.#participantId), kept, this.#remoteTracks);
    for (const [key, publication] of roster) this.#remoteTracks.set(key, publication);
    for (const publication of kept) {
      this.#subscribedPublicationIds.add(publication.publicationId);
      this.#invokeListener(() => this.#onRemoteTrack?.(publication));
    }
    // The server also pulled the tracks of Participants the roster does not list. No roster entry holds those receivers, so the reconcile that follows retires them.
    const held = this.#heldRemoteTracks();
    this.#queueDroppedReceivers(pulled.filter((publication) => !held.has(publication.track)));
    return listed.snapshot;
  }
  async #negotiateRemotePull(requested: readonly CloudflareSFUPublication[], generation: number, issue: (connectionId: string) => Promise<{ readonly publications: readonly CloudflareSFUPublication[]; readonly response: CloudflareSFUTracksResponse }>): Promise<readonly CloudflareSFURemoteTrack[]> {
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
        if (!this.#remotePullRetries.get(publication.publicationId)?.receiveStalled) this.#remotePullRetries.delete(publication.publicationId);
      }
      await this.#completeRenegotiation(response, connection, connectionId, generation);
      if (matched.length === 0) return [];
      await this.#waitForConnection(connection, generation).catch((error: unknown) => {
        // A connection that never went live is not a transient pull error: report it so the call recovers or fails.
        if (connection === this.#connection && this.#connectedEpoch !== this.#connectionEpoch && generation === this.#generation && !this.#stopped) this.#setFailure(error, "media_failed");
        throw error;
      });
      this.#negotiatedGeneration = generation;
      // The browser fires no track event when the SFU reuses a closed receiver that still receives the same stream, so a revived receiver counts as arrived.
      const arrived = (mid: string) => received.get(mid) ?? this.#revivedReceiverTrack(connection, mid);
      await (() => waitFor(() => responseTracks.every((track) => track.mid !== undefined && arrived(track.mid) !== undefined), 5000))();
      this.#requireGeneration(generation);
      return matched.map(({ publication, mid }) => {
        const track = arrived(mid);
        if (!track) throw new CloudflareSFUError("A negotiated remote track did not arrive", "media_failed");
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
      this.#receiveHealth.pullFailed(publication.publicationId, "CloudflareSFUError");
      this.#reportError(new CloudflareSFUError(`Cloudflare SFU remote track failed: ${failure.code}`, "media_failed", { providerCode: failure.code }));
    }
  }
  #recordReceivePullFailure(publications: readonly CloudflareSFUPublication[], generation: number, error: unknown): void {
    if (generation !== this.#generation || (error instanceof CloudflareSFUError && error.code === "stale_generation")) return;
    const kind = classifyMediaFailure(error, "sfu_tracks").media_error_kind;
    for (const publication of publications) this.#receiveHealth.pullFailed(publication.publicationId, kind);
  }
  #backoffRemotePull(publicationId: string, receiveStalled = false): void {
    const previous = this.#remotePullRetries.get(publicationId) ?? { retryAfter: 0, failures: 0 };
    const failures = Math.min(previous.failures + 1, 6);
    this.#remotePullRetries.set(publicationId, { retryAfter: Date.now() + Math.min(15_000, 750 * 2 ** (failures - 1)), failures, receiveStalled: receiveStalled || previous.receiveStalled });
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
        const mid = connection.getTransceivers().find((transceiver) => transceiver.receiver.track === change.track)?.mid;
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
          const { connectionId, trackName } = parseCloudflareSFUPublicationID(change.publicationId);
          return { location: "remote", mid, sessionId: connectionId, trackName, simulcast: { preferredRid: change.layer, priorityOrdering: "none", ridNotAvailable: "asciibetical" } };
        }),
      );
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
    for (const publicationId of advanced) this.#remotePullRetries.delete(publicationId);
    if (reads) this.#observeDelivery(now, connection, received, new Set(advanced), current);
    this.#publishSnapshot();
    if (!stalled.some((id) => this.#receiveProgress.canRepull(id) || (this.#replaceMediaConnection && this.#receiveProgress.canRebuild(id)))) return;
    for (const publicationId of stalled) {
      if (!this.#remotePullRetries.get(publicationId)?.receiveStalled) this.#backoffRemotePull(publicationId, true);
    }
    this.#remotePullIncomplete = true;
    this.remotePublicationsChanged();
  }
  #readsSubscriptions(): boolean {
    return this.#capabilities().subscriptionState && this.#transport?.listSubscriptions !== undefined;
  }
  // The SFU's subscription state decides whether a quiet video is stalled or paused for network.
  #observeDelivery(now: number, connection: RTCPeerConnection, received: readonly CloudflareSFURemoteTrack[], advanced: ReadonlySet<string>, current: () => boolean): void {
    const transceivers = connection.getTransceivers();
    const videos = received.flatMap((publication): DeliveredVideo[] => {
      if (!isVideoPublication(publication)) return [];
      const mid = transceivers.find((transceiver) => transceiver.receiver.track === publication.track)?.mid;
      if (!mid) return [];
      const { connectionId, trackName } = parseCloudflareSFUPublicationID(publication.publicationId);
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
      () => {
        if (current()) this.#delivery.failed(startedAt, performance.now());
      },
    );
  }
  async #completeRenegotiation(response: CloudflareSFUTracksResponse, connection: RTCPeerConnection, connectionId: string, generation: number): Promise<void> {
    if (response.sessionDescription?.type === "offer") await this.#applyProviderDescription(response, connection, { generation, connectionId });
  }
  // An answer completes our own offer. An offer comes from the SFU and must always be answered:
  // this peer is the polite one, so it rolls back a pending local offer first. A browser that
  // rolls back on its own would otherwise leave the SFU's offer unanswered.
  async #applyProviderDescription(response: CloudflareSFUTracksResponse, connection: RTCPeerConnection, owner: { readonly generation: number; readonly connectionId: string }): Promise<void> {
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
  // that the offer turns on must receive again before the answer is made. cf_sfu keeps offering every closed mid as sendonly (the
  // 2026-11-10 Orb churn probe), so only the mids the response names are revived; the others stay parked and get an inactive answer.
  #reviveInactiveTransceivers(connection: RTCPeerConnection, offerSDP: string, response: CloudflareSFUTracksResponse): void {
    const named = new Set((response.tracks ?? []).map((track) => track.mid));
    const active = activeOfferedMids(offerSDP);
    for (const transceiver of connection.getTransceivers()) {
      const { mid } = transceiver;
      if (transceiver.direction === "inactive" && mid !== null && named.has(mid) && active.has(mid)) transceiver.direction = "recvonly";
    }
  }
  async #applyProviderDescriptionIfOpen(response: CloudflareSFUTracksResponse, connection: RTCPeerConnection, owner: { readonly generation: number; readonly connectionId: string }): Promise<void> {
    if (!connectionIsClosed(connection)) await this.#applyProviderDescription(response, connection, owner);
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
      this.#reportPendingLocalOffer(this.#connection, "sdp_operation_start");
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
    this.#setPhase("recovering", null);
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
    let disconnectedTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const cameraPolicy = new CameraUplinkPolicy();
    const viewerLayers = new ViewerLayerSelector({ followsNetwork: !this.#capabilities().serverLayerAdaptation });
    let observedCamera: LocalTrackState | undefined;
    const observed = () => !disposed && generation === this.#generation && connectionEpoch === this.#connectionEpoch && !this.#stopped && connection.connectionState !== "closed";
    const current = () => observed() && connection.connectionState !== "failed";
    // Sampling skips a failed path but keeps its schedule, so an ICE restart on the same connection resumes it.
    const adaptCamera = async () => {
      try {
        if (!current()) return;
        const state = this.#localTracks.get("camera");
        if (state !== observedCamera) {
          cameraPolicy.reset();
          observedCamera = state;
        }
        const report = await connection.getStats();
        if (!current() || connection.signalingState !== "stable") return;
        this.#observeReceiveProgress(connection, report, current);
        this.#adaptViewerLayers(connection, report, viewerLayers, current);
        this.#callStats.observe(report, { hiddenVideos: this.#hiddenVideos, ...(this.#readsSubscriptions() ? { pausedVideos: this.#delivery.pausedForNetwork } : {}) });
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
      if (disposed || generation !== this.#generation || connectionEpoch !== this.#connectionEpoch || this.#stopped) return;
      if (connectionIsLive(connection)) this.#connectedEpoch = connectionEpoch;
      const observation = this.#observeIceRecovery(connection, connectionEpoch, observeConnectionState(connection.connectionState, connection.iceConnectionState, this.#started));
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
        this.#beginIceRestart(connection, generation, connectionEpoch);
        observe();
      }, ICE_DISCONNECTED_RESTART_MS);
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
  #restartsIceInPlace(): boolean {
    return this.#started && this.#capabilities().iceRestart;
  }
  // On an SFU that restarts ICE in place, a failed path first restarts ICE on the same session.
  // While that runs the phase stays recovering. Once it fails, every state, live included, reports
  // the failure until replacement: the attempt dropped an answer the SFU may have applied, so the
  // session's ICE credentials can no longer be trusted.
  #observeIceRecovery(connection: RTCPeerConnection, connectionEpoch: number, observation: ConnectionObservation): ConnectionObservation {
    if (observation?.phase === "failed") this.#beginIceRestart(connection, this.#generation, connectionEpoch);
    const restart = this.#iceRestartOf(connection, connectionEpoch);
    if (!restart) return observation;
    if (restart.state === "failed") return { phase: "failed", failure: this.#snapshot.failure ?? ICE_RESTART_FAILURE };
    if (connectionIsLive(connection)) {
      // A path that reconnects on its own settles the restart, so its budget cannot fail it later.
      if (restart.state === "running") restart.state = "succeeded";
      return observation;
    }
    return restart.state === "running" ? { phase: "recovering", failure: null } : observation;
  }
  #iceRestartOf(connection: RTCPeerConnection, connectionEpoch: number): IceRestart | null {
    const restart = this.#iceRestart;
    return restart && restart.connection === connection && restart.connectionEpoch === connectionEpoch ? restart : null;
  }
  #beginIceRestart(connection: RTCPeerConnection, generation: number, connectionEpoch: number): void {
    const previous = this.#iceRestartOf(connection, connectionEpoch);
    if (!this.#restartsIceInPlace() || (previous && previous.state !== "succeeded")) return;
    const restart: IceRestart = { connection, connectionEpoch, state: "running" };
    this.#iceRestart = restart;
    const current = () => this.#iceRestart === restart && connection === this.#connection && connectionEpoch === this.#connectionEpoch && generation === this.#generation && !this.#stopped;
    // Once the budget fails the attempt, every later step drops its result. A path that recovered on
    // its own still applies an answer the SFU sent, so both sides keep the same ICE credentials.
    const pending = () => current() && restart.state !== "failed";
    void this.#restartIceWithinBudget(connection, generation, pending).then(
      () => {
        restart.state = "succeeded";
      },
      (error: unknown) => {
        if (restart.state !== "running") return;
        restart.state = "failed";
        if (current()) this.#setFailure(error, "ice_connection_failed");
      },
    );
  }
  async #restartIceWithinBudget(connection: RTCPeerConnection, generation: number, current: () => boolean): Promise<void> {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => reject(new CloudflareSFUError("The ICE restart did not reconnect in time", "ice_connection_failed")), ICE_RESTART_BUDGET_MS);
    });
    try {
      await Promise.race([this.#restartIce(connection, generation, current), budget]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }
  // The restart offer keeps every media section, so the SFU keeps the session's publications and subscriptions.
  async #restartIce(connection: RTCPeerConnection, generation: number, current: () => boolean): Promise<void> {
    const connectionId = this.#bootstrap.connectionId;
    const stale = () => new CloudflareSFUError("Stale media connection", "stale_generation");
    await this.#serializeSDP(async () => {
      if (!current()) throw stale();
      // The path reconnected while earlier SDP work held the queue, so it needs no new credentials.
      if (connectionIsLive(connection)) return;
      const sessionDescription = await this.#createLocalOffer(connection, "ice_restart", { iceRestart: true });
      try {
        const response = await this.#signal(() => this.#addTracks({ connectionId, sessionDescription, tracks: [] }), { generation, connectionId });
        if (!current()) throw stale();
        await this.#applyProviderDescription(response, connection, { generation, connectionId });
      } catch (error) {
        await this.#rollbackLocalOffer(connection);
        throw error;
      }
    });
    await waitFor(
      () => {
        if (!current()) throw stale();
        return connectionIsLive(connection);
      },
      ICE_RESTART_BUDGET_MS,
      "The ICE restart did not reconnect in time",
    );
  }
  async #replaceDormantConnectionBeforeNegotiation(generation: number): Promise<void> {
    if (!this.#started || this.#negotiatedGeneration === generation || this.#replacementAttemptedGeneration === generation || !this.#replaceMediaConnection) return;
    // The own SFU keeps an unused connection until it reports it gone, and the publish recovers from that report.
    if (this.#capabilities().keepsIdleSession) return;
    await this.#replaceMediaConnectionForRecovery(generation, "dormant_connection");
  }
  #addTracks(input: Omit<Parameters<CloudflareSFUSignalingTransport["addTracks"]>[0], "replacementCause">): Promise<CloudflareSFUTracksResponse> {
    // The first signaling attempt on the new binding reports its origin, even if
    // that attempt fails. Extra query parameters also work with older APIs.
    const replacementCause = this.#replacementCause;
    this.#replacementCause = undefined;
    return this.#requireTransport().addTracks({ ...input, replacementCause });
  }
  #replaceMediaConnectionForRecovery(generation: number, cause: MediaConnectionReplacementCause): Promise<void> {
    this.#requireGeneration(generation);
    if (this.#replacement?.generation === generation) return this.#replacement.promise;
    if (!this.#replaceMediaConnection || this.#replacementAttemptedGeneration === generation) {
      return Promise.reject(new CloudflareSFUError("A fresh Cloudflare SFU connection is unavailable", "signaling_failed"));
    }
    this.#replacementAttemptedGeneration = generation;
    const replaceMediaConnection = this.#replaceMediaConnection;
    const promise = Promise.resolve().then(async () => {
      const bootstrap = await replaceMediaConnection();
      this.#requireGeneration(generation);
      validateBootstrap(bootstrap);
      if (bootstrap.connectionId === this.#bootstrap.connectionId) {
        throw new CloudflareSFUError("Participant access did not replace the Cloudflare SFU connection", "signaling_failed");
      }
      this.#fenceLocalPublications();
      const connectionEpoch = ++this.#connectionEpoch;
      // A connection that never negotiated carried nothing, so swapping it is no recovery. Saying "recovering" would
      // move the whole call to reconnecting and cut off any other enable that is running.
      if (cause !== "dormant_connection") this.#setPhase("recovering", null);
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
    });
    const replacement = { generation, promise };
    this.#replacement = replacement;
    void promise.then(
      () => {
        if (this.#replacement === replacement) this.#replacement = null;
      },
      () => {
        if (this.#replacement === replacement) this.#replacement = null;
      },
    );
    return promise;
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
    return create({ iceServers: iceServersFor(bootstrap), bundlePolicy: "max-bundle", iceCandidatePoolSize: 1 });
  }
  #rebuildPeerConnection(bootstrap: CloudflareSFUBootstrap, generation: number, connectionEpoch: number): void {
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
    this.#videoTilesChanged = true;
    this.#remotePullInputRevision++;
    this.#remotePullIncomplete = true;
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
  #schedulePoll(delayMs = this.#pollIntervalMs): void {
    if (this.#stopped || (!this.#started && !this.#receivingInitial) || this.#pollTimer !== undefined) return;
    this.#pollTimer = globalThis.setTimeout(async () => {
      this.#pollTimer = undefined;
      // Skip the network round-trip while the tab is hidden; the poll
      // reschedules itself and resumes on the next tick after visibility.
      if (pageIsHidden() && !this.#videoTilesChanged) {
        this.#schedulePoll();
        return;
      }
      const tilesChanged = this.#videoTilesChanged;
      this.#videoTilesChanged = false;
      let nextDelay = this.#pollIntervalMs;
      try {
        await this.refreshRemotePublications();
        nextDelay = this.#nextPollDelay();
      } catch {
        // A hidden tab polls only after a tile change, so a failed refresh keeps that change for the retry.
        if (tilesChanged) this.#videoTilesChanged = true;
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
  #nextPollDelay(): number {
    if (this.#remotePullIncomplete) return this.#incompletePullDelay();
    const repoll = SYNC_OFF_REPOLL_MS[this.#syncOffRepolls];
    if (repoll === undefined || !this.#heldTrackSyncShowsOff()) return this.#pollIntervalMs;
    this.#syncOffRepolls++;
    return repoll;
  }
  #heldTrackSyncShowsOff(): boolean {
    return this.#syncPublications.some(({ participantId, source, enabled }) => !enabled && this.#remoteTracks.has(publicationKey({ participantId, source })));
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
      remoteDelivery: this.#delivery.deliveries,
      callStats: this.#callStats.recent(),
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
  if (options.unreportedVideoTileWaitMs !== undefined && (!Number.isFinite(options.unreportedVideoTileWaitMs) || options.unreportedVideoTileWaitMs < 0)) {
    throw new CloudflareSFUError("Cloudflare SFU unreported video tile wait is invalid", "invalid_bootstrap");
  }
}
function validateBootstrap(bootstrap: CloudflareSFUBootstrap): void {
  if (!bootstrap.connectionId.trim() || (bootstrap.stunServer !== undefined && !bootstrap.stunServer.trim())) throw new CloudflareSFUError("Cloudflare SFU bootstrap is incomplete", "invalid_bootstrap");
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
function* chunks<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size);
}
// A remote track is never stopped: a stopped track stays ended for good, and the SFU reuses the mid of a closed one.
function droppedRemoteTracks(current: ReadonlyMap<string, CloudflareSFURemoteTrack>, next: ReadonlyMap<string, CloudflareSFURemoteTrack>): readonly CloudflareSFURemoteTrack[] {
  // The SFU can put a re-pull on the receiver it just closed, so the new publication keeps the old track. That receiver is live again.
  const kept = new Set([...next.values()].map((publication) => publication.track));
  return [...current].filter(([key, previous]) => next.get(key) !== previous && !kept.has(previous.track)).map(([, previous]) => previous);
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
function isVideoPublication(publication: Pick<CloudflareSFUPublication, "source">): boolean {
  return publication.source === "camera" || publication.source === "screen";
}
// Picture-in-picture events bubble from the video element to the document.
const PAGE_VISIBILITY_EVENTS = ["visibilitychange", "enterpictureinpicture", "leavepictureinpicture"] as const;
function pictureInPictureTracks(): readonly MediaStreamTrack[] {
  if (typeof document === "undefined" || typeof HTMLVideoElement === "undefined" || typeof MediaStream === "undefined") return [];
  const video = document.pictureInPictureElement;
  return video instanceof HTMLVideoElement && video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks() : [];
}
function pageIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
function connectionIsLive(connection: RTCPeerConnection): boolean {
  return connection.connectionState === "connected" && (connection.iceConnectionState === "connected" || connection.iceConnectionState === "completed");
}
// The MIDs of the sections an offer turns on: a section the SFU sends on, not one it keeps recvonly or inactive.
function activeOfferedMids(offerSDP: string): ReadonlySet<string> {
  const mids = new Set<string>();
  for (const section of offerSDP.split(/\r?\n(?=m=)/)) {
    const mid = /\r?\na=mid:(\S+)/.exec(section)?.[1];
    if (mid !== undefined && !/\r?\na=(?:recvonly|inactive)\b/.test(section)) mids.add(mid);
  }
  return mids;
}
// The MID of the m-section that owns the BUNDLE transport: the first one in the group of the last local description.
function bundleTagOf(connection: RTCPeerConnection): string | undefined {
  return /(?:^|\r?\n)a=group:BUNDLE[ \t]+(\S+)/.exec(connection.localDescription?.sdp ?? "")?.[1];
}
function connectionIsClosed(connection: RTCPeerConnection): boolean {
  return connection.connectionState === "closed";
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
function safeStopTransceiver(transceiver: RTCRtpTransceiver, onError: (error: unknown) => void): void {
  // On React Native a stopped transceiver is gone natively, so a second stop() rejects with "Could not get transceiver" and nothing can catch it.
  if (transceiver.direction === "stopped" || transceiver.currentDirection === "stopped") return;
  try {
    transceiver.stop();
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
    sharedRefsEqual(left, right) &&
    connectionEqual(left.connection, right.connection) &&
    cursorEqual(left.cursor, right.cursor) &&
    failureEqual(left.failure, right.failure) &&
    left.localTracks.length === right.localTracks.length &&
    left.remoteTracks.length === right.remoteTracks.length
  );
}
function sharedRefsEqual(left: CloudflareSFUSnapshot, right: CloudflareSFUSnapshot): boolean {
  return left.remoteDelivery === right.remoteDelivery && left.callStats === right.callStats;
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
type LocalOfferOrigin = Exclude<CloudflareSFULocalOfferDiagnostic["origin"], "outside_sdk">;
async function createLocalOffer(connection: RTCPeerConnection, options?: RTCOfferOptions) {
  const offer = await connection.createOffer(options);
  await connection.setLocalDescription(offer);
  return requireDescription(offer);
}
function localSourceGroup(source: MediaPublicationSource): readonly MediaPublicationSource[] {
  return source === "screen" ? [source, "screen_audio"] : [source];
}
function recoveryBackoffMs(attempt: number): number {
  return RECOVERY_BACKOFF_MS[Math.min(attempt, RECOVERY_BACKOFF_MS.length - 1)] ?? RECOVERY_BACKOFF_MS[RECOVERY_BACKOFF_MS.length - 1]!;
}
function isGonePublicationFailure(error: unknown): boolean {
  const failures: readonly unknown[] = error instanceof AggregateError ? error.errors : [error];
  return failures.length > 0 && failures.every((failure) => failure instanceof CloudflareSFUError && (failure.options.status === 404 || failure.options.status === 410));
}
function isRateLimited(error: unknown): boolean {
  return error instanceof CloudflareSFUError && error.options.status === 429;
}
function unwrapAggregateErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(unwrapAggregateErrors) : [error];
}
// A 5xx, a signaling timeout or a network failure usually clears in seconds, so the pull is retried
// after a short backoff. Rate limits (429), a gone connection (404, 410) and track failures stay on
// the long deferral, because an immediate retry cannot change their outcome.
function transientRemotePull(error: unknown): boolean {
  const { media_error_kind: kind, http_status: status } = classifyMediaFailure(error, "sfu_tracks");
  return kind === "network" || kind === "timeout" || (typeof status === "number" && status >= 500);
}
function retryableRemotePull(error: unknown): boolean {
  if (transientRemotePull(error)) return true;
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
  const failures = unwrapAggregateErrors(error);
  const terminal = failures.length > 0 && failures.every((failure) => failure instanceof CloudflareSFUError && failure.code === "signaling_failed" && typeof failure.options.status === "number" && failure.options.retryableConnection !== true && !isRateLimited(failure));
  return { outcome: ambiguous ? "ambiguous" : terminal ? "terminal_failure" : "retryable_failure", errorCode: code };
}
