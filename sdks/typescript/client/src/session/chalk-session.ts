import type { CloudflareSFUSnapshot } from "../media";
import type { V3SessionSnapshot } from "../sync";
import { ParticipantAccessError } from "./access";
import type { ParticipantAccessSubject } from "./access";
import { ChalkSessionAccessManager } from "./access-manager";
import type { ChalkSessionDiagnostic } from "./diagnostics";
import { ChalkSessionDiagnostics } from "./diagnostics";
import type { ChalkSessionAccessProvider, ChalkSessionDependencies, ChalkSessionMediaClient, ChalkSessionSyncClient } from "./dependencies";
import { requireDisplayVideoTrack, stopStream, streamFromTracks } from "./media-devices";
import { createDefaultChalkSessionDependencies } from "./production";
import { initialChalkSessionSnapshot, projectChalkSessionSnapshot } from "./snapshot";
import { ChalkSessionError } from "./types";
import type { ChalkAdmissionPolicy, ChalkAssignableParticipantRole, ChalkMediaSource, ChalkSessionActionName, ChalkSessionErrorCode, ChalkSessionFailure, ChalkSessionSnapshot, ChalkSessionState, ChalkSessionStore } from "./types";

const START_TIMEOUT_MS = 10_000;
const LEAVE_TIMEOUT_MS = 5_000;
const RECOVERY_BUDGET_MS = 10_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const REFRESH_RETRY_MS = 5_000;

type RecoveryKind = "sync" | "media";

export type ChalkSessionOptions = {
  readonly access: ChalkSessionAccessProvider;
  readonly syncURL: string;
  readonly apiBaseURL: string;
  readonly initialMicrophoneEnabled?: boolean;
  readonly initialCameraEnabled?: boolean;
  readonly accessRefreshWindowMs?: number;
  readonly recovery?: {
    readonly maxAttempts?: number;
    readonly budgetMs?: number;
    readonly backoffMs?: readonly number[];
  };
  readonly diagnostics?: {
    readonly limit?: number;
    readonly onEvent?: (event: ChalkSessionDiagnostic) => void;
  };
  readonly dependencies?: Partial<ChalkSessionDependencies>;
};

export class ChalkSession implements ChalkSessionStore {
  readonly #access: ChalkSessionAccessManager;
  readonly #dependencies: ChalkSessionDependencies;
  readonly #diagnostics: ChalkSessionDiagnostics;
  readonly #listeners = new Set<() => void>();
  readonly #localTracks = new Map<ChalkMediaSource, MediaStreamTrack>();
  readonly #mediaCommandTails = new Map<ChalkMediaSource, Promise<void>>();
  readonly #sleeps = new Set<{ readonly handle: unknown; readonly resolve: () => void }>();
  readonly #maxRecoveryAttempts: number;
  readonly #recoveryBackoffMs: readonly number[];
  readonly #recoveryBudgetMs: number;
  readonly #localIntent: Record<"microphone" | "camera", boolean>;
  #epoch = 0;
  #failure: ChalkSessionFailure | null = null;
  #failedCleanupRequired = false;
  #joinCleanupConfirmed: boolean | null = null;
  #joinPromise: Promise<void> | null = null;
  #leavePromise: Promise<void> | null = null;
  #media: ChalkSessionMediaClient | null = null;
  #mediaSnapshot: CloudflareSFUSnapshot | null = null;
  #pendingRecovery: RecoveryKind | null = null;
  #recoveryPromise: Promise<void> | null = null;
  #refreshTimer: unknown;
  #screenEndedPending = false;
  #snapshot = initialChalkSessionSnapshot();
  #state: ChalkSessionState = "idle";
  #sync: ChalkSessionSyncClient | null = null;
  #syncRecoveryTimer: unknown;
  #syncSnapshot: V3SessionSnapshot | null = null;
  #teardownPromise: Promise<boolean> | null = null;
  #unsubscribeMedia: (() => void) | null = null;
  #unsubscribeSync: (() => void) | null = null;

  constructor(options: ChalkSessionOptions) {
    if (!options.access) throw new TypeError("A participant access provider is required");
    const defaults = createDefaultChalkSessionDependencies({ apiBaseURL: options.apiBaseURL, syncURL: options.syncURL });
    this.#dependencies = { ...defaults, ...options.dependencies };
    this.#access = new ChalkSessionAccessManager(options.access, this.#dependencies.clock.now, options.accessRefreshWindowMs);
    this.#localIntent = {
      microphone: options.initialMicrophoneEnabled ?? true,
      camera: options.initialCameraEnabled ?? true,
    };
    this.#maxRecoveryAttempts = boundedInteger(options.recovery?.maxAttempts, MAX_RECOVERY_ATTEMPTS, 1, 10);
    this.#recoveryBudgetMs = boundedInteger(options.recovery?.budgetMs, RECOVERY_BUDGET_MS, 1, 60_000);
    this.#recoveryBackoffMs = options.recovery?.backoffMs?.length ? [...options.recovery.backoffMs] : [100, 250, 500];
    this.#diagnostics = new ChalkSessionDiagnostics({ now: this.#dependencies.clock.now, ...options.diagnostics });
  }

  getSnapshot = (): ChalkSessionSnapshot => this.#snapshot;

  getDiagnostics(): readonly ChalkSessionDiagnostic[] {
    return this.#diagnostics.snapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  join = (): Promise<void> => {
    if (this.#state === "joining" && this.#joinPromise) return this.#joinPromise;
    if (this.#state === "live") return Promise.resolve();
    const blocker = this.#joinBlocker();
    if (blocker) return Promise.reject(this.#error("invalid_state", "join", false, blocker));

    this.#resetForJoin();
    const epoch = ++this.#epoch;
    this.#transition("joining");
    const promise = this.#performJoin(epoch).finally(() => {
      if (this.#joinPromise === promise) this.#joinPromise = null;
    });
    this.#joinPromise = promise;
    return promise;
  };

  #joinBlocker(): string | null {
    if (this.#state === "leaving" || this.#state === "reconnecting") return `Cannot join while ${this.#state}`;
    if (this.#state === "failed" && (this.#failedCleanupRequired || !this.#isFullyTornDown())) return "Cannot join until failed session cleanup completes";
    if (this.#state === "left" && this.#mediaCommandTails.size > 0) return "Cannot join until prior media commands settle";
    return null;
  }

  leave = (): Promise<void> => {
    if (this.#state === "idle" || this.#state === "left") return Promise.resolve();
    if (this.#state === "leaving" && this.#leavePromise) return this.#leavePromise;
    const wasJoining = this.#state === "joining";
    ++this.#epoch;
    this.#transition("leaving");
    const promise = (async () => {
      if (wasJoining) await this.#joinPromise?.catch(() => undefined);
      const confirmed = wasJoining && this.#joinCleanupConfirmed !== null ? this.#joinCleanupConfirmed : await this.#teardown(true);
      const failure = confirmed ? null : this.#failureValue("leave_unconfirmed", "leave", false, "The session left locally without a durable Leave acknowledgement");
      this.#failure = failure;
      this.#transition("left");
      if (failure) throw new ChalkSessionError(failure);
    })().finally(() => {
      if (this.#leavePromise === promise) this.#leavePromise = null;
    });
    this.#leavePromise = promise;
    return promise;
  };

  setMicrophoneEnabled = (enabled: boolean): Promise<void> => this.#setUserMediaEnabled("microphone", enabled);

  setCameraEnabled = (enabled: boolean): Promise<void> => this.#setUserMediaEnabled("camera", enabled);

  startScreenShare = (): Promise<void> => this.#serializeMediaCommand("screen", "startScreenShare", (epoch) => this.#runCommand("startScreenShare", () => this.#startScreenShare(epoch)));

  async #startScreenShare(epoch: number): Promise<void> {
    if (this.#localTracks.has("screen")) return;
    const media = this.#media!;
    const sync = this.#sync!;
    let stream: MediaStream | null = null;
    let prepared = false;
    try {
      stream = await this.#dependencies.mediaDevices.getDisplayMedia({ video: true, audio: false });
      this.#assertCommandEpoch(epoch, "startScreenShare");
      const track = requireDisplayVideoTrack(stream);
      this.#screenEndedPending = false;
      this.#localTracks.set("screen", track);
      media.prepareLocalTrack("screen", track);
      prepared = true;
      this.#publish();
      await sync.setScreenShareEnabled(true);
      this.#assertCommandEpoch(epoch, "startScreenShare");
    } catch (error) {
      if (prepared) await media.clearPreparedLocalTrack("screen").catch(() => undefined);
      else stopStream(stream);
      this.#localTracks.delete("screen");
      this.#publish();
      if (isPermissionDenied(error)) throw this.#error("permission_denied", "startScreenShare", true, "Screen sharing permission was denied", error);
      throw error;
    }
  }

  stopScreenShare = (): Promise<void> => this.#serializeMediaCommand("screen", "stopScreenShare", (epoch) => this.#stopScreenShare(epoch));

  #stopScreenShare(epoch: number): Promise<void> {
    if (!this.#localTracks.has("screen")) return Promise.resolve();
    return this.#runCommand("stopScreenShare", async () => {
      const sync = this.#sync!;
      const media = this.#media!;
      await sync.setScreenShareEnabled(false);
      this.#assertCommandEpoch(epoch, "stopScreenShare");
      await media.clearPreparedLocalTrack("screen");
      this.#assertCommandEpoch(epoch, "stopScreenShare");
      this.#localTracks.delete("screen");
      this.#publish();
    });
  }

  setHandRaised = (raised: boolean): Promise<void> => this.#runCommand("setHandRaised", () => this.#sync!.setHandRaised(raised));
  setDisplayName = (displayName: string): Promise<void> => this.#runCommand("setDisplayName", () => this.#sync!.setDisplayName(displayName));
  setAdmissionPolicy = (policy: ChalkAdmissionPolicy): Promise<void> => this.#runCommand("setAdmissionPolicy", () => this.#sync!.setAdmissionPolicy(policy));
  setParticipantRole = (participantSessionId: string, role: ChalkAssignableParticipantRole): Promise<void> => this.#runCommand("setParticipantRole", () => this.#sync!.setParticipantRole(participantSessionId, role));
  transferHost = (participantSessionId: string): Promise<void> => this.#runCommand("transferHost", () => this.#sync!.transferHost(participantSessionId));
  admitParticipant = (admissionRequestId: string): Promise<void> => this.#runCommand("admitParticipant", () => this.#sync!.admit(admissionRequestId));
  denyAdmission = (admissionRequestId: string): Promise<void> => this.#runCommand("denyAdmission", () => this.#sync!.deny(admissionRequestId));
  muteParticipant = (participantSessionId: string): Promise<void> => this.#runCommand("muteParticipant", () => this.#sync!.muteParticipant(participantSessionId));
  stopParticipantCamera = (participantSessionId: string): Promise<void> => this.#runCommand("stopParticipantCamera", () => this.#sync!.stopParticipantCamera(participantSessionId));
  stopParticipantScreenShare = (participantSessionId: string): Promise<void> => this.#runCommand("stopParticipantScreenShare", () => this.#sync!.stopParticipantScreenShare(participantSessionId));
  removeParticipant = (participantSessionId: string): Promise<void> => this.#runCommand("removeParticipant", () => this.#sync!.removeParticipant(participantSessionId));
  endSession = (): Promise<void> => this.#runCommand("endSession", () => this.#sync!.endSession());

  async #performJoin(epoch: number): Promise<void> {
    let stream: MediaStream | null = null;
    try {
      stream = await this.#acquireInitialMedia();
      this.#assertEpoch(epoch);
      const access = await this.#access.initialize();
      this.#assertEpoch(epoch);
      this.#media = this.#dependencies.createMediaClient({
        access,
        credential: () => this.#access.getMediaToken(),
        onFailure: () => this.#handleMediaFailure(),
        onScreenEnded: () => this.#handleScreenEnded(),
      });
      this.#sync = this.#dependencies.createSyncClient({ access, token: () => this.#access.getSyncToken(), media: this.#media });
      this.#subscribeLowerLayers();
      const media = this.#media;
      const sync = this.#sync;
      await Promise.all([
        media.start(stream).catch((cause) => {
          throw new StartupFailure("media", cause);
        }),
        sync
          .start()
          .then(() => this.#waitForSyncLive(sync, START_TIMEOUT_MS))
          .catch((cause) => {
            throw new StartupFailure("sync", cause);
          }),
      ]);
      this.#assertEpoch(epoch);
      this.#failure = null;
      this.#transition("live");
      this.#scheduleAccessRefresh();
    } catch (cause) {
      if (!this.#media) stopStream(stream);
      const cancelled = cause instanceof StaleEpoch;
      const confirmed = await this.#teardown(this.#access.current !== null);
      this.#joinCleanupConfirmed = confirmed;
      if (cancelled && this.#state === "leaving") throw this.#error("invalid_state", "join", false, "Join was cancelled by Leave", cause);
      const error = confirmed ? this.#joinError(cause) : this.#error("join_cleanup_unconfirmed", "join", false, "Join failed and durable cleanup could not be confirmed", cause);
      this.#failure = failureFrom(error);
      this.#transition("failed");
      throw error;
    }
  }

  async #acquireInitialMedia(): Promise<MediaStream> {
    if (!this.#localIntent.microphone && !this.#localIntent.camera) return streamFromTracks([]);
    try {
      const stream = await this.#dependencies.mediaDevices.getUserMedia({ audio: this.#localIntent.microphone, video: this.#localIntent.camera });
      for (const [source, track] of selectInitialTracks(stream, this.#localIntent)) this.#localTracks.set(source, track);
      this.#publish();
      return streamFromTracks([...this.#localTracks.values()]);
    } catch (cause) {
      throw this.#captureError(cause);
    }
  }

  async #setUserMediaEnabled(source: "microphone" | "camera", enabled: boolean): Promise<void> {
    const action = source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled";
    return this.#serializeMediaCommand(source, action, (epoch) => this.#runCommand(action, () => this.#applyUserMediaEnabled(source, enabled, action, epoch)));
  }

  #serializeMediaCommand(source: ChalkMediaSource, action: ChalkSessionActionName, operation: (epoch: number) => Promise<void>): Promise<void> {
    const epoch = this.#epoch;
    const previous = this.#mediaCommandTails.get(source) ?? Promise.resolve();
    const execute = () => {
      this.#assertCommandEpoch(epoch, action);
      return operation(epoch);
    };
    const current = previous.then(execute, execute);
    const tail = current.catch(() => undefined);
    this.#mediaCommandTails.set(source, tail);
    void tail.then(() => {
      if (this.#mediaCommandTails.get(source) === tail) this.#mediaCommandTails.delete(source);
    });
    return current;
  }

  async #applyUserMediaEnabled(source: "microphone" | "camera", enabled: boolean, action: "setMicrophoneEnabled" | "setCameraEnabled", epoch: number): Promise<void> {
    const previousIntent = this.#localIntent[source];
    this.#localIntent[source] = enabled;
    let acquired = false;
    try {
      acquired = await this.#prepareUserMediaSource(source, enabled, action, epoch);
      await this.#setSyncMediaEnabled(source, enabled, action, epoch);
    } catch (error) {
      this.#localIntent[source] = previousIntent;
      if (acquired) await this.#discardPreparedSource(source);
      this.#publish();
      if (isPermissionDenied(error)) throw this.#error("permission_denied", action, true, `${source} permission was denied`, error);
      throw error;
    }
    this.#publish();
  }

  async #prepareUserMediaSource(source: "microphone" | "camera", enabled: boolean, action: "setMicrophoneEnabled" | "setCameraEnabled", epoch: number): Promise<boolean> {
    if (!enabled || this.#localTracks.has(source)) return false;
    const stream = await this.#dependencies.mediaDevices.getUserMedia(mediaConstraints(source));
    try {
      this.#assertCommandEpoch(epoch, action);
    } catch (error) {
      stopStream(stream);
      throw error;
    }
    const track = selectSourceTrack(stream, source);
    this.#localTracks.set(source, track);
    try {
      this.#media!.prepareLocalTrack(source, track);
      this.#publish();
      return true;
    } catch (error) {
      track.stop();
      this.#localTracks.delete(source);
      throw error;
    }
  }

  async #setSyncMediaEnabled(source: "microphone" | "camera", enabled: boolean, action: "setMicrophoneEnabled" | "setCameraEnabled", epoch: number): Promise<void> {
    if (!this.#localTracks.has(source)) return;
    const sync = this.#sync!;
    if (source === "microphone") await sync.setMicrophoneEnabled(enabled);
    else await sync.setCameraEnabled(enabled);
    this.#assertCommandEpoch(epoch, action);
  }

  async #discardPreparedSource(source: "microphone" | "camera"): Promise<void> {
    await this.#media?.clearPreparedLocalTrack(source).catch(() => undefined);
    this.#localTracks.delete(source);
  }

  async #runCommand(action: ChalkSessionActionName, operation: () => Promise<unknown>): Promise<void> {
    if (this.#state !== "live" || !this.#sync || !this.#media) throw this.#error("invalid_state", action, false, `Cannot ${action} while ${this.#state}`);
    try {
      await operation();
    } catch (cause) {
      if (cause instanceof ChalkSessionError) throw cause;
      throw this.#error("command_rejected", action, true, `${action} was not confirmed`, cause);
    }
  }

  #subscribeLowerLayers(): void {
    this.#unsubscribeSync?.();
    this.#unsubscribeMedia?.();
    const sync = this.#sync!;
    const media = this.#media!;
    this.#unsubscribeSync = sync.subscribe((snapshot) => this.#handleSyncSnapshot(snapshot));
    this.#unsubscribeMedia = media.subscribe(() => this.#handleMediaSnapshot(media.getSnapshot()));
    this.#handleMediaSnapshot(media.getSnapshot());
  }

  #handleSyncSnapshot(snapshot: V3SessionSnapshot): void {
    this.#syncSnapshot = snapshot;
    if (syncSubjectMismatch(snapshot, this.#access.current?.subject ?? null)) {
      this.#failRuntime("invalid_access", "Sync authenticated a different participant subject");
      return;
    }
    if (syncSessionEnded(snapshot)) {
      this.#failRuntime("session_ended", "The session has ended");
      return;
    }
    if (this.#isRuntimeActive()) this.#handleSyncConnection(snapshot.connection.phase);
    this.#publish();
  }

  #handleSyncConnection(phase: V3SessionSnapshot["connection"]["phase"]): void {
    if (phase === "terminal") {
      this.#requestRecovery("sync");
      return;
    }
    if (phase === "connecting" || phase === "recovering") {
      this.#transition("reconnecting");
      this.#scheduleSyncRecoveryWatchdog();
      return;
    }
    if (phase !== "live") return;
    this.#clearSyncRecoveryWatchdog();
    this.#returnToLiveIfHealthy();
  }

  #handleMediaSnapshot(snapshot: CloudflareSFUSnapshot): void {
    this.#mediaSnapshot = snapshot;
    this.#handleMediaConnection(snapshot);
    this.#publish();
  }

  #handleMediaConnection(snapshot: CloudflareSFUSnapshot): void {
    if (this.#isRuntimeActive() && snapshot.connection.phase === "failed" && snapshot.failure?.recoverable) this.#requestRecovery("media");
    else if (this.#isRuntimeActive() && snapshot.connection.phase === "recovering") this.#transition("reconnecting");
    else if (snapshot.connection.phase === "live") this.#returnToLiveIfHealthy();
  }

  #handleMediaFailure(): void {
    const snapshot = this.#media?.getSnapshot();
    if (snapshot) this.#handleMediaSnapshot(snapshot);
  }

  #requestRecovery(kind: RecoveryKind): void {
    if (this.#state !== "live" && this.#state !== "reconnecting") return;
    this.#pendingRecovery = this.#pendingRecovery === "media" ? "media" : kind;
    this.#transition("reconnecting");
    if (this.#recoveryPromise) return;
    const promise = this.#runRecoveryLoop().finally(() => {
      if (this.#recoveryPromise === promise) this.#recoveryPromise = null;
    });
    this.#recoveryPromise = promise;
    void promise.catch(() => undefined);
  }

  async #runRecoveryLoop(): Promise<void> {
    while (this.#pendingRecovery && this.#isRuntimeActive()) {
      const kind = this.#pendingRecovery;
      this.#pendingRecovery = null;
      const outcome = await this.#recoverWithinBudget(kind);
      if (outcome === "stale") return;
      if (outcome === "exhausted") {
        await this.#exhaustRecovery(kind);
        return;
      }
    }
  }

  async #recoverWithinBudget(kind: RecoveryKind): Promise<"recovered" | "stale" | "exhausted"> {
    const deadline = this.#dependencies.clock.now() + this.#recoveryBudgetMs;
    for (let attempt = 1; this.#recoveryAttemptAllowed(attempt, deadline); attempt++) {
      const outcome = await this.#attemptRecovery(kind, attempt, deadline);
      if (outcome !== "failed") return outcome;
      await this.#waitBeforeRecoveryRetry(attempt, deadline);
    }
    return "exhausted";
  }

  async #attemptRecovery(kind: RecoveryKind, attempt: number, deadline: number): Promise<"recovered" | "stale" | "failed"> {
    const epoch = ++this.#epoch;
    this.#diagnostics.record({ event: "recovery_attempt", state: this.#state, epoch, attempt });
    try {
      const recovery = kind === "media" ? this.#recoverMedia(epoch) : this.#recoverSync(epoch);
      await this.#withTimeout(recovery, Math.max(0, deadline - this.#dependencies.clock.now()));
      this.#assertEpoch(epoch);
      this.#diagnostics.record({ event: "recovery_succeeded", state: this.#state, epoch, attempt });
      this.#returnToLiveIfHealthy();
      return "recovered";
    } catch (error) {
      if (error instanceof StaleEpoch) return "stale";
      if (this.#epoch === epoch) this.#epoch++;
      return "failed";
    }
  }

  #recoveryAttemptAllowed(attempt: number, deadline: number): boolean {
    return attempt <= this.#maxRecoveryAttempts && this.#dependencies.clock.now() < deadline;
  }

  async #waitBeforeRecoveryRetry(attempt: number, deadline: number): Promise<void> {
    if (attempt >= this.#maxRecoveryAttempts) return;
    const delay = Math.max(0, this.#recoveryBackoffMs[Math.min(attempt - 1, this.#recoveryBackoffMs.length - 1)] ?? 0);
    if (this.#dependencies.clock.now() + delay < deadline) await this.#sleep(delay);
  }

  async #exhaustRecovery(kind: RecoveryKind): Promise<void> {
    const code = kind === "media" ? "media_recovery_exhausted" : "sync_recovery_exhausted";
    this.#failure = this.#failureValue(code, null, false, `${kind} recovery exhausted its retry budget`);
    this.#diagnostics.record({ event: "recovery_exhausted", state: this.#state, epoch: this.#epoch, code });
    this.#failedCleanupRequired = true;
    this.#transition("failed");
    await this.#teardown(false);
  }

  async #recoverMedia(epoch: number): Promise<void> {
    const access = await this.#access.refresh("media_recovery", true);
    this.#assertEpoch(epoch);
    await this.#media!.restart(access.media.clientPayload);
    this.#assertEpoch(epoch);
    this.#mediaSnapshot = this.#media!.getSnapshot();
    await this.#waitForSyncLive(this.#sync!, this.#recoveryBudgetMs);
  }

  async #recoverSync(epoch: number): Promise<void> {
    await this.#access.getSyncToken("sync_recovery");
    this.#assertEpoch(epoch);
    this.#unsubscribeSync?.();
    this.#sync?.stop();
    const access = this.#access.current!;
    const sync = this.#dependencies.createSyncClient({ access, token: () => this.#access.getSyncToken(), media: this.#media! });
    this.#sync = sync;
    this.#unsubscribeSync = sync.subscribe((snapshot) => this.#handleSyncSnapshot(snapshot));
    await sync.start();
    await this.#waitForSyncLive(sync, this.#recoveryBudgetMs);
    this.#assertEpoch(epoch);
  }

  #scheduleAccessRefresh(delay = this.#access.millisecondsUntilRefresh()): void {
    this.#clearRefreshTimer();
    if (delay === null || this.#state !== "live") return;
    this.#refreshTimer = this.#dependencies.clock.setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.#access
        .refresh("scheduled_refresh", false)
        .then(() => {
          this.#diagnostics.record({ event: "access_refreshed", state: this.#state, epoch: this.#epoch });
          this.#scheduleAccessRefresh();
        })
        .catch(() => {
          this.#diagnostics.record({ event: "access_refresh_failed", state: this.#state, epoch: this.#epoch, code: "access_unavailable" });
          this.#scheduleAccessRefresh(REFRESH_RETRY_MS);
        });
    }, delay);
  }

  #scheduleSyncRecoveryWatchdog(): void {
    if (this.#syncRecoveryTimer !== undefined) return;
    this.#syncRecoveryTimer = this.#dependencies.clock.setTimeout(() => {
      this.#syncRecoveryTimer = undefined;
      if (this.#state === "reconnecting" && this.#syncSnapshot?.connection.phase !== "live") this.#requestRecovery("sync");
    }, this.#recoveryBudgetMs);
  }

  async #teardown(durableLeave: boolean): Promise<boolean> {
    if (this.#teardownPromise) return this.#teardownPromise;
    const promise = this.#performTeardown(durableLeave).finally(() => {
      if (this.#teardownPromise === promise) this.#teardownPromise = null;
    });
    this.#teardownPromise = promise;
    return promise;
  }

  async #performTeardown(durableLeave: boolean): Promise<boolean> {
    this.#cancelRuntimeWork();
    const confirmed = await this.#confirmDurableLeave(durableLeave);
    this.#stopLowerLayers();
    this.#failedCleanupRequired = false;
    this.#diagnostics.record({ event: "cleanup_completed", state: this.#state, epoch: this.#epoch });
    this.#publish();
    return confirmed;
  }

  #cancelRuntimeWork(): void {
    this.#clearRefreshTimer();
    this.#clearSyncRecoveryWatchdog();
    this.#clearSleeps();
    this.#pendingRecovery = null;
    this.#screenEndedPending = false;
    this.#unsubscribeSync?.();
    this.#unsubscribeSync = null;
    this.#unsubscribeMedia?.();
    this.#unsubscribeMedia = null;
  }

  async #confirmDurableLeave(durableLeave: boolean): Promise<boolean> {
    if (!durableLeave || this.#access.current === null) return true;
    if (!this.#sync) return false;
    try {
      await this.#withTimeout(this.#sync.leave(), LEAVE_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  #stopLowerLayers(): void {
    this.#sync?.stop();
    this.#media?.stop();
    this.#syncSnapshot = this.#sync?.getSnapshot() ?? null;
    this.#mediaSnapshot = this.#media?.getSnapshot() ?? null;
    for (const track of this.#localTracks.values()) track.stop();
    this.#localTracks.clear();
    this.#sync = null;
    this.#media = null;
    this.#access.clear();
  }

  #waitForSyncLive(sync: ChalkSessionSyncClient, timeoutMs: number): Promise<void> {
    if (sync.getSnapshot().connection.phase === "live") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const timer = this.#dependencies.clock.setTimeout(() => finish(() => reject(new TypeError("Sync did not become live before the startup deadline"))), timeoutMs);
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        this.#dependencies.clock.clearTimeout(timer);
        unsubscribe?.();
        complete();
      };
      unsubscribe = sync.subscribe((snapshot) => {
        if (snapshot.connection.phase === "live") finish(resolve);
        else if (snapshot.connection.phase === "terminal" || snapshot.connection.phase === "stopped") finish(() => reject(new TypeError("Sync stopped before becoming live")));
      });
      if (settled) unsubscribe();
    });
  }

  #withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.#dependencies.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new TypeError("Operation timed out"));
      }, timeoutMs);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.#dependencies.clock.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.#dependencies.clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  #sleep(milliseconds: number): Promise<void> {
    if (milliseconds === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const pending = {
        handle: undefined as unknown,
        resolve: () => {
          this.#sleeps.delete(pending);
          resolve();
        },
      };
      pending.handle = this.#dependencies.clock.setTimeout(pending.resolve, milliseconds);
      this.#sleeps.add(pending);
    });
  }

  #returnToLiveIfHealthy(): void {
    if (this.#state !== "reconnecting") return;
    if (this.#syncSnapshot?.connection.phase !== "live" || this.#mediaSnapshot?.connection.phase !== "live") return;
    this.#transition("live");
    this.#scheduleAccessRefresh();
    if (this.#screenEndedPending) {
      this.#screenEndedPending = false;
      void this.stopScreenShare().catch(() => undefined);
    }
  }

  #isRuntimeActive(): boolean {
    return this.#state === "live" || this.#state === "reconnecting";
  }

  #isFullyTornDown(): boolean {
    return !this.#teardownPromise && !this.#sync && !this.#media && this.#localTracks.size === 0 && this.#mediaCommandTails.size === 0 && this.#access.current === null;
  }

  #handleScreenEnded(): void {
    if (!this.#localTracks.has("screen")) return;
    if (this.#state === "reconnecting") {
      this.#screenEndedPending = true;
      return;
    }
    void this.stopScreenShare().catch(() => undefined);
  }

  #failRuntime(code: "invalid_access" | "session_ended", message: string): void {
    if (this.#state === "leaving" || this.#state === "left") return;
    ++this.#epoch;
    this.#failure = this.#failureValue(code, null, false, message);
    this.#failedCleanupRequired = true;
    this.#transition("failed");
    void this.#teardown(false);
  }

  #transition(state: ChalkSessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#diagnostics.record({ event: "state_changed", state, epoch: this.#epoch });
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = projectChalkSessionSnapshot({
      state: this.#state,
      subject: this.#access.current?.subject ?? null,
      sync: this.#syncSnapshot,
      media: this.#mediaSnapshot,
      localTracks: this.#localTracks,
      localIntent: this.#localIntent,
      failure: this.#failure,
    });
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Consumer listeners cannot interfere with session ownership.
      }
    }
  }

  #resetForJoin(): void {
    this.#failure = null;
    this.#syncSnapshot = null;
    this.#mediaSnapshot = null;
    this.#pendingRecovery = null;
    this.#joinCleanupConfirmed = null;
    this.#screenEndedPending = false;
    this.#failedCleanupRequired = false;
  }

  #assertEpoch(epoch: number): void {
    if (epoch !== this.#epoch) throw new StaleEpoch();
  }

  #assertCommandEpoch(epoch: number, action: ChalkSessionActionName): void {
    if (epoch !== this.#epoch) throw this.#error("invalid_state", action, false, `${action} belongs to an inactive session`);
  }

  #clearRefreshTimer(): void {
    if (this.#refreshTimer !== undefined) this.#dependencies.clock.clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  #clearSyncRecoveryWatchdog(): void {
    if (this.#syncRecoveryTimer !== undefined) this.#dependencies.clock.clearTimeout(this.#syncRecoveryTimer);
    this.#syncRecoveryTimer = undefined;
  }

  #clearSleeps(): void {
    for (const pending of this.#sleeps) {
      this.#dependencies.clock.clearTimeout(pending.handle);
      pending.resolve();
    }
    this.#sleeps.clear();
  }

  #joinError(cause: unknown): ChalkSessionError {
    if (cause instanceof ChalkSessionError) return cause;
    if (cause instanceof StartupFailure) {
      const code = cause.layer === "sync" ? "sync_start_failed" : "media_start_failed";
      return this.#error(code, "join", true, `The ${cause.layer} layer could not start`, cause.cause);
    }
    if (cause instanceof ParticipantAccessError || (cause instanceof TypeError && this.#access.current === null)) return this.#error("invalid_access", "join", false, "Participant access was rejected", cause);
    const code = this.#access.current === null ? "access_unavailable" : this.#syncSnapshot?.connection.phase !== "live" ? "sync_start_failed" : "media_start_failed";
    return this.#error(code, "join", code === "access_unavailable", "The session could not join", cause);
  }

  #captureError(cause: unknown): ChalkSessionError {
    if (isPermissionDenied(cause)) return this.#error("permission_denied", "join", true, "Camera or microphone permission was denied", cause);
    return this.#error("unsupported_environment", "join", false, "Browser media capture is unavailable", cause);
  }

  #error(code: ChalkSessionErrorCode, action: ChalkSessionActionName | null, recoverable: boolean, message: string, cause?: unknown): ChalkSessionError {
    return new ChalkSessionError(this.#failureValue(code, action, recoverable, message), cause === undefined ? undefined : { cause });
  }

  #failureValue(code: ChalkSessionErrorCode, action: ChalkSessionActionName | null, recoverable: boolean, message: string): ChalkSessionFailure {
    return Object.freeze({ code, action, recoverable, message });
  }
}

class StaleEpoch extends Error {}

class StartupFailure extends Error {
  constructor(
    readonly layer: "sync" | "media",
    override readonly cause: unknown,
  ) {
    super(`${layer} startup failed`);
  }
}

function failureFrom(error: ChalkSessionError): ChalkSessionFailure {
  return Object.freeze({ code: error.code, action: error.action, recoverable: error.recoverable, message: error.message });
}

function selectInitialTracks(stream: MediaStream, intent: Readonly<Record<"microphone" | "camera", boolean>>): Map<"microphone" | "camera", MediaStreamTrack> {
  const tracks = stream.getTracks();
  const microphone = requestedTrack(tracks, "audio", intent.microphone);
  const camera = requestedTrack(tracks, "video", intent.camera);
  const selected = new Set([microphone, camera].filter((track): track is MediaStreamTrack => track !== undefined));
  stopUnselectedTracks(tracks, selected);
  requireRequestedTracks(intent, microphone, camera, selected);
  return selectedTrackMap(microphone, camera);
}

function requestedTrack(tracks: readonly MediaStreamTrack[], kind: "audio" | "video", required: boolean): MediaStreamTrack | undefined {
  return required ? tracks.find((track) => track.kind === kind) : undefined;
}

function stopUnselectedTracks(tracks: readonly MediaStreamTrack[], selected: ReadonlySet<MediaStreamTrack>): void {
  for (const track of tracks) {
    if (!selected.has(track)) track.stop();
  }
}

function requireRequestedTracks(intent: Readonly<Record<"microphone" | "camera", boolean>>, microphone: MediaStreamTrack | undefined, camera: MediaStreamTrack | undefined, selected: ReadonlySet<MediaStreamTrack>): void {
  const missing = (intent.microphone && !microphone) || (intent.camera && !camera);
  if (!missing) return;
  for (const track of selected) track.stop();
  throw new TypeError("Media capture did not return every requested track");
}

function selectedTrackMap(microphone: MediaStreamTrack | undefined, camera: MediaStreamTrack | undefined): Map<"microphone" | "camera", MediaStreamTrack> {
  const entries: ["microphone" | "camera", MediaStreamTrack][] = [];
  if (microphone) entries.push(["microphone", microphone]);
  if (camera) entries.push(["camera", camera]);
  return new Map(entries);
}

function mediaConstraints(source: "microphone" | "camera"): MediaStreamConstraints {
  return { audio: source === "microphone", video: source === "camera" };
}

function selectSourceTrack(stream: MediaStream, source: "microphone" | "camera"): MediaStreamTrack {
  const kind = source === "microphone" ? "audio" : "video";
  const selected = stream.getTracks().find((track) => track.kind === kind);
  if (!selected) {
    stopStream(stream);
    throw new TypeError(`Media capture did not return a ${source} track`);
  }
  for (const track of stream.getTracks()) {
    if (track !== selected) track.stop();
  }
  return selected;
}

function syncSubjectMismatch(snapshot: V3SessionSnapshot, subject: ParticipantAccessSubject | null): boolean {
  if (!subject || snapshot.participantSessionId === null) return false;
  return snapshot.participantSessionId !== subject.participantSessionId || snapshot.participantSessionGeneration !== subject.participantGeneration;
}

function syncSessionEnded(snapshot: V3SessionSnapshot): boolean {
  return snapshot.control?.status === "ended" || snapshot.optimisticControl?.status === "ended";
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Expected an integer between ${minimum} and ${maximum}`);
  return value;
}
