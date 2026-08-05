import { Clock, Context, Data, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Scope, SubscriptionRef } from "effect";
import type { CloudflareSFUSnapshot } from "../media";
import type { V1EpisodeSnapshot } from "../sync";
import { ConnectionAccessFailure, ConnectionAccessService, makeConnectionAccessLayer } from "../access/manager";
import { AccessGrantError, type ParsedAccessGrant } from "../access/grant";
import type { ConnectionLifecycleSnapshot, ConnectionOptions, ConnectionPorts } from "./index";
import { ConnectionDiagnostics, type ConnectionDiagnostic, type ConnectionJoinTraceEvent, type ConnectionJoinTraceStep } from "./diagnostics";
import { ConnectionPlatformService, makeConnectionPlatformLayer, type ConnectionDependencies, type ConnectionMediaClient, type ConnectionSyncClient } from "./dependencies";
import { stopStream, streamFromTracks } from "./media-devices";
import { createDefaultConnectionDependencies } from "./production";
import { ConnectionError, type ConnectionConnectionPhase, type ConnectionFailure, type ConnectionState } from "./types";

const START_TIMEOUT_MS = 10_000;
const LEAVE_TIMEOUT_MS = 5_000;
const RECOVERY_BUDGET_MS = 10_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const REFRESH_RETRY_MS = 5_000;

type RecoveryKind = "sync" | "media";
type RecoveryPlan = {
  readonly kind: RecoveryKind;
  readonly deadline: number;
  readonly attempts: number;
  readonly delays: readonly number[];
};
type InitialMedia = (intent: Readonly<{ microphone: boolean; camera: boolean }>) => Effect.Effect<MediaStream, unknown>;
type LifecycleFailureCode = ConnectionFailure["code"];

export class ConnectionLifecycleFailure extends Data.TaggedError("ConnectionLifecycleFailure")<{
  readonly code: LifecycleFailureCode;
  readonly recoverable: boolean;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type ConnectionLifecycleCapability = {
  readonly snapshotRef: SubscriptionRef.SubscriptionRef<ConnectionLifecycleSnapshot>;
  readonly changes: typeof SubscriptionRef.changes<ConnectionLifecycleSnapshot>;
  readonly getSnapshot: () => ConnectionLifecycleSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribePorts: (listener: (ports: ConnectionPorts | null) => void) => () => void;
  readonly subscribeScreenEnded: (listener: () => void) => () => void;
  readonly getDiagnostics: () => readonly ConnectionDiagnostic[];
  readonly getJoinTrace: () => readonly ConnectionJoinTraceEvent[];
  readonly setInitialMedia: (provider: InitialMedia) => Effect.Effect<void>;
  readonly configureJoin: (intent: Readonly<{ microphone?: boolean; camera?: boolean }>) => Effect.Effect<void, ConnectionLifecycleFailure>;
  readonly getSyncToken: () => Effect.Effect<string, ConnectionLifecycleFailure>;
  readonly confirmEpisodeEnded: Effect.Effect<void>;
  readonly join: () => Effect.Effect<void, ConnectionLifecycleFailure>;
  readonly leave: () => Effect.Effect<void, ConnectionLifecycleFailure>;
  readonly runCommand: <A, E>(operation: (ports: ConnectionPorts) => Effect.Effect<A, E>) => Effect.Effect<A, ConnectionLifecycleFailure | E>;
  readonly runPortCommand: <A, E>(operation: () => Effect.Effect<A, E>) => Effect.Effect<A, ConnectionLifecycleFailure | E>;
  readonly nowUnsafe: () => number;
  readonly scheduleUnsafe: (callback: () => void, milliseconds: number) => unknown;
  readonly cancelScheduleUnsafe: (handle: unknown) => void;
  readonly createId: () => string;
};

export class ConnectionLifecycleService extends Context.Service<ConnectionLifecycleService, ConnectionLifecycleCapability>()("@chalk/client/ConnectionLifecycle") {}

type Model = {
  state: ConnectionState;
  sync: ConnectionSyncClient | null;
  media: ConnectionMediaClient | null;
  syncSnapshot: V1EpisodeSnapshot | null;
  mediaSnapshot: CloudflareSFUSnapshot | null;
  failure: ConnectionFailure | null;
  initialMedia: InitialMedia;
  intent: { microphone: boolean; camera: boolean };
  episodeEndConfirmed: boolean;
  activeScope: Scope.Closeable | null;
  syncBindingCleanup: (() => void) | null;
  mediaBindingCleanup: (() => void) | null;
  refreshFiber: Fiber.Fiber<void, unknown> | null;
  recoveryQueued: RecoveryKind | null;
  joinCancelled: boolean;
  closed: boolean;
  epoch: number;
};

type Work = {
  readonly effect: Effect.Effect<unknown, unknown>;
  readonly deferred: Deferred.Deferred<unknown, unknown>;
  readonly join: boolean;
};

/**
 * Effect-owned lifecycle actor. All mutable lifecycle state changes on its
 * Queue; browser/media/sync callbacks only enqueue work back into the actor.
 */
export const makeConnectionLifecycleLayer = (options: ConnectionOptions) => {
  const defaults = createDefaultConnectionDependencies({ apiBaseURL: options.apiBaseURL, syncURL: options.syncURL });
  const platform = { ...defaults, ...options.dependencies } satisfies ConnectionDependencies;
  const access = makeConnectionAccessLayer(
    (request) =>
      Effect.tryPromise({
        try: () => Promise.resolve(options.access(request)),
        catch: (cause) => new ConnectionAccessFailure({ code: "access.unavailable", cause }),
      }),
    options.accessRefreshWindowMs,
  );
  const clock = Layer.succeed(Clock.Clock, {
    currentTimeMillisUnsafe: platform.clock.now,
    currentTimeMillis: Effect.sync(platform.clock.now),
    currentTimeNanosUnsafe: () => BigInt(platform.clock.now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(platform.clock.now()) * 1_000_000n),
    sleep: (duration) =>
      Effect.callback((resume) => {
        const handle = platform.clock.setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        return Effect.sync(() => platform.clock.clearTimeout(handle));
      }),
  });
  const lifecycle = makeConnectionLifecycleLayerFromServices(options)
    .pipe(Layer.provide(Layer.mergeAll(access, makeConnectionPlatformLayer(platform))))
    .pipe(Layer.provide(clock));
  // Clock is a Context reference in Effect 4; provide builds it eagerly even
  // though the reference remains in the conditional Layer requirement type.
  return lifecycle as Layer.Layer<ConnectionLifecycleService, never>;
};

export const makeFakeConnectionLifecycleLayer = makeConnectionLifecycleLayer;

export const makeConnectionLifecycleLayerFromServices = (options: Omit<ConnectionOptions, "access" | "dependencies">) =>
  Layer.effect(
    ConnectionLifecycleService,
    Effect.gen(function* () {
      const access = yield* Effect.service(ConnectionAccessService);
      const platform = yield* Effect.service(ConnectionPlatformService);
      const clock = yield* Clock.Clock;
      const context = yield* Effect.context<ConnectionAccessService | ConnectionPlatformService | Clock.Clock>();
      const serviceScope = yield* Effect.scope;
      const diagnostics = new ConnectionDiagnostics({ now: () => clock.currentTimeMillisUnsafe(), ...options.diagnostics });
      const snapshotRef = yield* SubscriptionRef.make<ConnectionLifecycleSnapshot>(idleSnapshot());
      const queue = yield* Queue.unbounded<Work>();
      const listeners = new Set<() => void>();
      const portListeners = new Set<(ports: ConnectionPorts | null) => void>();
      const screenEndedListeners = new Set<() => void>();
      let joinDeferred: Deferred.Deferred<void, ConnectionLifecycleFailure> | null = null;
      let activeJoin: Fiber.Fiber<void, ConnectionLifecycleFailure> | null = null;
      let fallbackIdentifier = 0;
      const model: Model = {
        state: "idle",
        sync: null,
        media: null,
        syncSnapshot: null,
        mediaSnapshot: null,
        failure: null,
        initialMedia: (intent) =>
          Effect.tryPromise({
            try: () => (intent.microphone || intent.camera ? platform.mediaDevices.getUserMedia({ audio: intent.microphone, video: intent.camera }) : Promise.resolve(streamFromTracks([]))),
            catch: (cause) => cause,
          }),
        intent: { microphone: options.initialMicrophoneEnabled ?? true, camera: options.initialCameraEnabled ?? true },
        episodeEndConfirmed: false,
        activeScope: null,
        syncBindingCleanup: null,
        mediaBindingCleanup: null,
        refreshFiber: null,
        recoveryQueued: null,
        joinCancelled: false,
        closed: false,
        epoch: 0,
      };

      const foreign = <A>(operation: () => Promise<A>, code: LifecycleFailureCode = "internal_error", message = "A browser transport operation failed"): Effect.Effect<A, ConnectionLifecycleFailure> =>
        Effect.tryPromise({ try: operation, catch: (cause) => lifecycleFailure(code, true, message, cause) });
      const toPromise = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);
      const publish = (): Effect.Effect<void> =>
        Effect.sync(() => snapshotFor(model, access.currentUnsafe()?.subject ?? null)).pipe(
          Effect.tap((snapshot) => SubscriptionRef.set(snapshotRef, snapshot)),
          Effect.asVoid,
          Effect.tap(() =>
            Effect.sync(() => {
              for (const listener of listeners) {
                try {
                  listener();
                } catch {
                  // Observer failures cannot affect lifecycle ownership.
                }
              }
            }),
          ),
        );
      const emitPorts = (): Effect.Effect<void> =>
        Effect.sync(() => {
          const ports = portsFor(model);
          for (const listener of portListeners) {
            try {
              listener(ports);
            } catch {
              // Feature observers cannot affect lifecycle ownership.
            }
          }
        });
      const transition = (state: ConnectionState): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (model.state === state) return;
          model.state = state;
          diagnostics.record({ event: "state_changed", state, epoch: model.epoch });
          yield* publish();
        });
      const enqueue = <A, E>(effect: Effect.Effect<A, E>, join = false): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          if (model.closed) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "The Connection scope is closed")) as Effect.Effect<never, E>;
          const deferred = yield* Deferred.make<A, E>();
          yield* Queue.offer(queue, { effect, deferred, join } as Work);
          return yield* Deferred.await(deferred);
        });
      const enqueueBackground = (effect: Effect.Effect<unknown, unknown>) => {
        void Effect.runForkWith(context)(enqueue(effect).pipe(Effect.ignore));
      };
      const stopRefresh = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          const fiber = model.refreshFiber;
          model.refreshFiber = null;
          return fiber ? Fiber.interrupt(fiber) : Effect.void;
        });
      const scheduleRefresh = (delay?: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* stopRefresh();
          if (!active(model)) return;
          const milliseconds = delay ?? (yield* access.millisecondsUntilRefresh) ?? 0;
          const scope = model.activeScope;
          if (!scope) return;
          model.refreshFiber = yield* Effect.forkIn(Effect.sleep(Math.max(0, milliseconds)).pipe(Effect.andThen(enqueue(refreshAccess())), Effect.ignore), scope);
        });
      const refreshAccess = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!active(model)) return;
          const epoch = model.epoch;
          const result = yield* Effect.exit(access.ensureFresh("scheduled_refresh"));
          if (result._tag === "Failure") {
            diagnostics.record({ event: "access_refresh_failed", state: model.state, epoch, code: "access_unavailable" });
            yield* scheduleRefresh(REFRESH_RETRY_MS);
            return;
          }
          diagnostics.record({ event: "access_refreshed", state: model.state, epoch });
          yield* publish();
          yield* scheduleRefresh();
        });
      const stopPorts = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* stopRefresh();
          const scope = model.activeScope;
          model.activeScope = null;
          model.sync = null;
          model.media = null;
          model.syncSnapshot = null;
          model.mediaSnapshot = null;
          yield* emitPorts();
          if (scope) yield* Scope.close(scope, Exit.void);
          yield* access.clear;
          yield* publish();
        });
      const bindSync = (scope: Scope.Closeable, sync: ConnectionSyncClient): Effect.Effect<void> =>
        Effect.gen(function* () {
          model.syncBindingCleanup?.();
          const unsubscribe = sync.subscribe((snapshot) => enqueueBackground(handleSyncSnapshot(sync, snapshot)));
          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            unsubscribe();
            sync.stop();
            if (model.syncBindingCleanup === cleanup) model.syncBindingCleanup = null;
          };
          model.syncBindingCleanup = cleanup;
          yield* Scope.addFinalizer(scope, Effect.sync(cleanup));
        });
      const bindMedia = (scope: Scope.Closeable, media: ConnectionMediaClient): Effect.Effect<void> =>
        Effect.gen(function* () {
          model.mediaBindingCleanup?.();
          const unsubscribe = media.subscribe(() => enqueueBackground(handleMediaSnapshot(media, media.getSnapshot())));
          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            unsubscribe();
            media.stop();
            if (model.mediaBindingCleanup === cleanup) model.mediaBindingCleanup = null;
          };
          model.mediaBindingCleanup = cleanup;
          yield* Scope.addFinalizer(scope, Effect.sync(cleanup));
        });
      const bindPorts = (scope: Scope.Closeable): Effect.Effect<void> =>
        Effect.gen(function* () {
          const sync = model.sync!;
          const media = model.media!;
          yield* bindSync(scope, sync);
          yield* bindMedia(scope, media);
          yield* handleMediaSnapshot(media, media.getSnapshot());
        });
      const waitForSyncLive = (sync: ConnectionSyncClient, timeoutMs: number): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.callback<void, ConnectionLifecycleFailure>((resume) => {
          if (sync.getSnapshot().connection.phase === "live") {
            resume(Effect.void);
            return;
          }
          const unsubscribe = sync.subscribe((snapshot) => {
            if (snapshot.connection.phase === "live") resume(Effect.void);
            else if (snapshot.connection.phase === "terminal" || snapshot.connection.phase === "stopped") resume(Effect.fail(lifecycleFailure("sync_start_failed", true, "Sync stopped before becoming live")));
          });
          return Effect.sync(unsubscribe);
        }).pipe(
          Effect.timeout(timeoutMs),
          Effect.catchTag("TimeoutError", () => Effect.fail(lifecycleFailure("sync_start_failed", true, "Sync did not become live before the startup deadline"))),
        );
      const trace = <A, E>(step: Exclude<ConnectionJoinTraceStep, "join">, effect: Effect.Effect<A, E>): Effect.Effect<A, E> => {
        const span = diagnostics.startSpan({ step, state: model.state, epoch: model.epoch });
        return effect.pipe(
          Effect.tap(() => Effect.sync(() => span.end({ state: model.state, epoch: model.epoch, outcome: "succeeded" }))),
          Effect.tapError(() => Effect.sync(() => span.end({ state: model.state, epoch: model.epoch, outcome: "failed" }))),
        );
      };
      const performJoin = (reason: "join" | "access_retry" = "join", retried = false): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          if (model.state === "live") return;
          if (model.state === "leaving" || model.closed) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Cannot join an inactive Connection"));
          model.epoch += 1;
          model.failure = null;
          model.episodeEndConfirmed = false;
          yield* transition("joining");
          const span = diagnostics.startSpan({ step: "join", state: model.state, epoch: model.epoch });
          const scope = yield* Scope.make("sequential");
          model.activeScope = scope;
          let stream: MediaStream | null = null;
          yield* Effect.gen(function* () {
            if (model.joinCancelled) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Join was cancelled by Leave"));
            stream = yield* trace("acquire_initial_media", model.initialMedia(model.intent).pipe(Effect.mapError((cause) => captureFailure(cause))));
            if (model.joinCancelled) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Join was cancelled by Leave"));
            const grant = yield* trace("access_initialize", access.initialize(reason));
            const media = yield* trace(
              "create_media_client",
              Effect.try({
                try: () =>
                  platform.createMediaClient({
                    access: grant,
                    credential: () => toPromise(access.getMediaToken()),
                    onFailure: () => enqueueBackground(handleMediaFailure()),
                    onScreenEnded: () => enqueueBackground(notifyScreenEnded()),
                  }),
                catch: (cause) => (accessRejected(cause) ? lifecycleFailure("invalid_access", false, "Access was rejected", cause) : lifecycleFailure("media_start_failed", true, "The media layer could not start", cause)),
              }),
            );
            model.media = media;
            const sync = yield* trace(
              "create_sync_client",
              Effect.try({
                try: () => platform.createSyncClient({ access: grant, token: () => toPromise(access.getSyncToken()), media, telemetry: options.telemetry }),
                catch: (cause) => (accessRejected(cause) ? lifecycleFailure("invalid_access", false, "Access was rejected", cause) : lifecycleFailure("sync_start_failed", true, "The sync layer could not start", cause)),
              }),
            );
            model.sync = sync;
            yield* bindPorts(scope);
            yield* Effect.all(
              [
                trace(
                  "start_media",
                  foreign(() => media.start(stream!), "media_start_failed", "The media layer could not start"),
                ),
                trace("start_sync", foreign(() => sync.start(), "sync_start_failed", "The sync layer could not start").pipe(Effect.andThen(trace("wait_for_sync_live", waitForSyncLive(sync, boundedInteger(options.syncStartupTimeoutMs, START_TIMEOUT_MS, 1, 60_000)))))),
              ],
              { concurrency: "unbounded", discard: true },
            );
          }).pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
                Effect.gen(function* () {
                  stopStream(stream);
                  const failure = failureFromCause(cause, "sync_start_failed", "The Connection could not start");
                  model.failure = toFailure(failure);
                  if (model.joinCancelled) {
                    span.end({ state: model.state, epoch: model.epoch, outcome: "cancelled", code: "invalid_state" });
                    return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Join was cancelled by Leave"));
                  }
                  yield* stopPorts();
                  if (!retried && failure.code === "invalid_access") return yield* performJoin("access_retry", true);
                  yield* transition("failed");
                  span.end({ state: model.state, epoch: model.epoch, outcome: "failed", code: failure.code });
                  return yield* Effect.fail(failure);
                }),
              onSuccess: () =>
                Effect.gen(function* () {
                  model.syncSnapshot = model.sync?.getSnapshot() ?? null;
                  model.mediaSnapshot = model.media?.getSnapshot() ?? null;
                  yield* transition("live");
                  yield* emitPorts();
                  yield* scheduleRefresh();
                  span.end({ state: model.state, epoch: model.epoch, outcome: "succeeded" });
                }),
            }),
          );
        });
      const performLeave = (): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* performLeaveEffect() {
          if (model.state === "idle" || model.state === "left") return;
          yield* transition("leaving");
          const confirmed = yield* leaveIsConfirmed();
          yield* stopPorts();
          model.failure = confirmed ? null : toFailure(lifecycleFailure("leave_unconfirmed", false, "The Episode left locally without a durable Leave acknowledgement"));
          diagnostics.record({ event: confirmed ? "cleanup_completed" : "cleanup_unconfirmed", state: model.state, epoch: model.epoch, ...(confirmed ? {} : { code: "leave_unconfirmed" }) });
          yield* transition("left");
          if (!confirmed) return yield* Effect.fail(lifecycleFailure("leave_unconfirmed", false, "The Episode left locally without a durable Leave acknowledgement"));
        });
      const leaveIsConfirmed = (): Effect.Effect<boolean> =>
        Effect.gen(function* leaveIsConfirmedEffect() {
          const sync = model.sync;
          if (!sync || model.episodeEndConfirmed || access.currentUnsafe() === null) return true;
          const leave = foreign(() => sync.leave()).pipe(Effect.timeout(LEAVE_TIMEOUT_MS));
          return (yield* Effect.exit(leave))._tag === "Success";
        });
      const withFreshAccess = <A, E>(operation: () => Effect.Effect<A, E>): Effect.Effect<A, ConnectionLifecycleFailure | E> =>
        Effect.gen(function* () {
          if (yield* access.requiresRefresh) {
            yield* access.ensureFresh("scheduled_refresh").pipe(Effect.mapError(accessFailure));
            diagnostics.record({ event: "access_refreshed", state: model.state, epoch: model.epoch });
            yield* scheduleRefresh();
          }
          return yield* operation().pipe(
            Effect.matchEffect({
              onSuccess: Effect.succeed,
              onFailure: (cause) => {
                if (!accessRejected(cause)) return Effect.fail(cause);
                return access.refreshAfterRejection().pipe(
                  Effect.mapError(accessFailure),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      diagnostics.record({ event: "access_refreshed", state: model.state, epoch: model.epoch });
                    }),
                  ),
                  Effect.andThen(scheduleRefresh()),
                  Effect.andThen(operation()),
                );
              },
            }),
          );
        });
      const recover = (kind: RecoveryKind): Effect.Effect<void> =>
        Effect.gen(function* recoverEffect() {
          if (!active(model)) return;
          if (model.recoveryQueued === kind) return;
          model.recoveryQueued = kind;
          yield* transition("reconnecting");
          const plan = yield* recoveryPlan(kind);
          const attempt = yield* attemptRecovery(plan);
          if (attempt !== null) return yield* finishRecovery(attempt);
          yield* failRecovery(plan);
        });
      const recoveryPlan = (kind: RecoveryKind): Effect.Effect<RecoveryPlan> =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => ({
            kind,
            deadline: now + boundedInteger(options.recovery?.budgetMs, RECOVERY_BUDGET_MS, 1, 60_000),
            attempts: boundedInteger(options.recovery?.maxAttempts, MAX_RECOVERY_ATTEMPTS, 1, 10),
            delays: options.recovery?.backoffMs?.length ? options.recovery.backoffMs : [100, 250, 500],
          })),
        );
      const attemptRecovery = (plan: RecoveryPlan): Effect.Effect<number | null> =>
        Effect.gen(function* attemptRecoveryEffect() {
          for (let attempt = 1; attempt <= plan.attempts; attempt += 1) {
            const remaining = plan.deadline - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return null;
            diagnostics.record({ event: "recovery_attempt", state: model.state, epoch: model.epoch, attempt });
            const outcome = yield* Effect.exit(recoveryOperation(plan.kind).pipe(Effect.timeout(remaining)));
            if (outcome._tag === "Success") return attempt;
            if (attempt < plan.attempts) yield* Effect.sleep(recoveryDelay(plan, attempt));
          }
          return null;
        });
      const recoveryOperation = (kind: RecoveryKind): Effect.Effect<void, ConnectionLifecycleFailure> => (kind === "media" ? recoverMedia() : recoverSync());
      const recoveryDelay = (plan: RecoveryPlan, attempt: number): number => Math.max(0, plan.delays[Math.min(attempt - 1, plan.delays.length - 1)] ?? 0);
      const finishRecovery = (attempt: number): Effect.Effect<void> =>
        Effect.gen(function* finishRecoveryEffect() {
          model.recoveryQueued = null;
          diagnostics.record({ event: "recovery_succeeded", state: model.state, epoch: model.epoch, attempt });
          yield* transition("live");
          yield* scheduleRefresh();
        });
      const failRecovery = (plan: RecoveryPlan): Effect.Effect<void> =>
        Effect.gen(function* failRecoveryEffect() {
          const code = plan.kind === "media" ? "media_recovery_exhausted" : "sync_recovery_exhausted";
          model.recoveryQueued = null;
          model.failure = toFailure(lifecycleFailure(code, false, `${plan.kind} recovery exhausted its retry budget`));
          diagnostics.record({ event: "recovery_exhausted", state: model.state, epoch: model.epoch, code });
          yield* stopPorts();
          yield* transition("failed");
        });
      const recoverMedia = (): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          const media = model.media;
          const sync = model.sync;
          if (!media || !sync) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Media recovery requires active ports"));
          const grant = yield* access.refresh("media_recovery", true).pipe(Effect.mapError(accessFailure));
          yield* foreign(() => media.restart(grant.media.clientPayload));
          model.mediaSnapshot = media.getSnapshot();
          yield* waitForSyncLive(sync, boundedInteger(options.recovery?.budgetMs, RECOVERY_BUDGET_MS, 1, 60_000));
        });
      const recoverSync = (): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          const media = model.media;
          const scope = model.activeScope;
          const grant = access.currentUnsafe();
          if (!media || !scope || !grant) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Sync recovery requires active ports"));
          yield* access.getSyncToken("sync_recovery").pipe(Effect.mapError(accessFailure));
          model.syncBindingCleanup?.();
          model.sync = null;
          const sync = yield* Effect.try({
            try: () => platform.createSyncClient({ access: grant, token: () => toPromise(access.getSyncToken()), media, telemetry: options.telemetry }),
            catch: (cause) => lifecycleFailure("sync_start_failed", true, "The sync layer could not start", cause),
          });
          model.sync = sync;
          yield* bindSync(scope, sync);
          yield* foreign(() => sync.start());
          yield* waitForSyncLive(sync, boundedInteger(options.recovery?.budgetMs, RECOVERY_BUDGET_MS, 1, 60_000));
          yield* emitPorts();
        });
      const handleSyncSnapshot = (sync: ConnectionSyncClient, snapshot: V1EpisodeSnapshot): Effect.Effect<void> =>
        Effect.gen(function* handleSyncSnapshotEffect() {
          if (!isCurrentSyncSnapshot(sync, snapshot)) return;
          model.syncSnapshot = snapshot;
          if (syncSubjectMismatched(access.currentUnsafe()?.subject ?? null, snapshot)) return yield* failForSnapshot(lifecycleFailure("invalid_access", false, "Sync authenticated a different participant subject"));
          if (episodeEnded(snapshot)) return yield* failForSnapshot(lifecycleFailure("episode_ended", false, "The Episode has ended"));
          if (syncNeedsRecovery(snapshot)) yield* recover("sync");
          yield* publish();
        });
      const isCurrentSyncSnapshot = (sync: ConnectionSyncClient, snapshot: V1EpisodeSnapshot): boolean => sync === model.sync && snapshot !== model.syncSnapshot;
      const syncSubjectMismatched = (subject: NonNullable<ReturnType<typeof access.currentUnsafe>>["subject"] | null, snapshot: V1EpisodeSnapshot): boolean =>
        subject !== null && snapshot.participantId !== null && (subject.participantId !== snapshot.participantId || subject.participantGeneration !== snapshot.participantGeneration);
      const episodeEnded = (snapshot: V1EpisodeSnapshot): boolean => snapshot.control?.status === "ended" || snapshot.optimisticControl?.status === "ended";
      const syncNeedsRecovery = (snapshot: V1EpisodeSnapshot): boolean => active(model) && (snapshot.connection.phase === "terminal" || snapshot.connection.phase === "recovering");
      const failForSnapshot = (failure: ConnectionLifecycleFailure): Effect.Effect<void> =>
        Effect.gen(function* failForSnapshotEffect() {
          model.failure = toFailure(failure);
          yield* stopPorts();
          yield* transition("failed");
        });
      const handleMediaSnapshot = (media: ConnectionMediaClient, snapshot: CloudflareSFUSnapshot): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (media !== model.media || media.getSnapshot() !== snapshot) return;
          if (snapshot === model.mediaSnapshot) return;
          model.mediaSnapshot = snapshot;
          if (active(model) && snapshot.connection.phase === "failed" && snapshot.failure?.recoverable) yield* recover("media");
          yield* publish();
        });
      const handleMediaFailure = (): Effect.Effect<void> => (model.media ? handleMediaSnapshot(model.media, model.media.getSnapshot()) : Effect.void);
      const notifyScreenEnded = (): Effect.Effect<void> =>
        Effect.sync(() => {
          if (!active(model)) return;
          for (const listener of screenEndedListeners) {
            try {
              listener();
            } catch {
              // Feature callbacks cannot affect lifecycle ownership.
            }
          }
        });
      const process = (work: Work): Effect.Effect<void> =>
        work.join
          ? Effect.gen(function* () {
              const fiber = yield* Effect.forkIn(work.effect as Effect.Effect<void, ConnectionLifecycleFailure>, serviceScope);
              activeJoin = fiber;
              const exit = yield* Effect.exit(Fiber.join(fiber));
              activeJoin = null;
              joinDeferred = null;
              yield* Deferred.done(work.deferred, exit);
            })
          : Deferred.complete(work.deferred, work.effect).pipe(Effect.asVoid);
      yield* Effect.forkScoped(Queue.take(queue).pipe(Effect.flatMap(process), Effect.forever));
      const foregroundUnsubscribe = platform.subscribeForeground?.(() => enqueueBackground(refreshAccess())) ?? null;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          model.closed = true;
          foregroundUnsubscribe?.();
          if (activeJoin) yield* Fiber.interrupt(activeJoin);
          yield* performLeave().pipe(Effect.ignore);
        }),
      );

      return {
        snapshotRef,
        changes: SubscriptionRef.changes,
        getSnapshot: () => SubscriptionRef.getUnsafe(snapshotRef),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        subscribePorts: (listener) => {
          portListeners.add(listener);
          listener(portsFor(model));
          return () => portListeners.delete(listener);
        },
        subscribeScreenEnded: (listener) => {
          screenEndedListeners.add(listener);
          return () => screenEndedListeners.delete(listener);
        },
        getDiagnostics: () => diagnostics.snapshot(),
        getJoinTrace: () => diagnostics.joinTrace(),
        setInitialMedia: (provider) =>
          Effect.sync(() => {
            model.initialMedia = provider;
          }),
        configureJoin: (intent) =>
          Effect.sync(() => {
            if (model.state !== "idle" && model.state !== "left" && model.state !== "failed") throw lifecycleFailure("invalid_state", false, `Cannot configure Join while ${model.state}`);
            if (intent.microphone !== undefined) model.intent.microphone = intent.microphone;
            if (intent.camera !== undefined) model.intent.camera = intent.camera;
          }),
        getSyncToken: () => access.getSyncToken().pipe(Effect.mapError(accessFailure)),
        confirmEpisodeEnded: Effect.sync(() => {
          model.episodeEndConfirmed = true;
        }),
        join: () =>
          Effect.suspend(() => {
            if (model.state === "live") return Effect.void;
            if (joinDeferred) return Deferred.await(joinDeferred);
            return Effect.gen(function* () {
              const deferred = yield* Deferred.make<void, ConnectionLifecycleFailure>();
              model.joinCancelled = false;
              joinDeferred = deferred;
              yield* Queue.offer(queue, { effect: performJoin(), deferred, join: true } as Work);
              return yield* Deferred.await(deferred);
            });
          }),
        leave: () =>
          Effect.gen(function* () {
            model.joinCancelled = true;
            if (activeJoin) yield* Fiber.interrupt(activeJoin);
            return yield* enqueue(performLeave());
          }),
        runCommand: (operation) =>
          enqueue(
            Effect.gen(function* () {
              const ports = portsFor(model);
              if (model.state !== "live" || !ports) return yield* Effect.fail(lifecycleFailure("invalid_state", false, `Cannot run a command while ${model.state}`));
              const value = yield* withFreshAccess(() => operation(ports));
              if (model.state !== "live") return yield* Effect.fail(lifecycleFailure("invalid_state", false, "The command belongs to an inactive Connection"));
              return value;
            }),
          ),
        runPortCommand: (operation) => enqueue(withFreshAccess(operation)),
        nowUnsafe: () => clock.currentTimeMillisUnsafe(),
        scheduleUnsafe: (callback, milliseconds) => platform.clock.setTimeout(callback, milliseconds),
        cancelScheduleUnsafe: (handle) => platform.clock.clearTimeout(handle),
        createId: () => platform.createId?.() ?? `local-${++fallbackIdentifier}`,
      } satisfies ConnectionLifecycleCapability;
    }),
  );

function idleSnapshot(): ConnectionLifecycleSnapshot {
  return Object.freeze({ state: "idle", subject: null, episode: null, connection: Object.freeze({ sync: "idle", media: "idle" }), failure: null });
}

function snapshotFor(model: Model, subject: ParsedAccessGrant["subject"] | null): ConnectionLifecycleSnapshot {
  const control = model.syncSnapshot?.optimisticControl ?? model.syncSnapshot?.control;
  return Object.freeze({
    state: model.state,
    subject: subject ? Object.freeze({ ...subject }) : null,
    episode: subject ? Object.freeze({ id: subject.episodeId, startedAt: null, deadline: control ? new Date(control.deadlineAtMs).toISOString() : null }) : null,
    connection: Object.freeze({ sync: syncPhase(model.syncSnapshot?.connection.phase), media: mediaPhase(model.mediaSnapshot?.connection.phase) }),
    failure: model.failure ? Object.freeze({ ...model.failure }) : null,
  });
}

function portsFor(model: Model): ConnectionPorts | null {
  return model.sync && model.media ? { sync: model.sync, media: model.media } : null;
}

function active(model: Model): boolean {
  return model.state === "live" || model.state === "reconnecting";
}

function lifecycleFailure(code: LifecycleFailureCode, recoverable: boolean, message: string, cause?: unknown): ConnectionLifecycleFailure {
  return new ConnectionLifecycleFailure({ code, recoverable, message, ...(cause === undefined ? {} : { cause }) });
}

function toFailure(value: ConnectionLifecycleFailure): ConnectionFailure {
  return Object.freeze({ code: value.code, action: null, recoverable: value.recoverable, message: value.message });
}

function accessFailure(value: ConnectionAccessFailure): ConnectionLifecycleFailure {
  return lifecycleFailure(value.code === "access.invalid" ? "invalid_access" : "access_unavailable", value.code === "access.unavailable", "Access was rejected", value.cause);
}

function captureFailure(cause: unknown): ConnectionLifecycleFailure {
  if (cause instanceof DOMException && cause.name === "NotAllowedError") return lifecycleFailure("permission_denied", true, "Media permission was denied", cause);
  return lifecycleFailure("unsupported_environment", false, "Browser media capture is unavailable", cause);
}

function failureFromCause(cause: unknown, code: LifecycleFailureCode, message: string): ConnectionLifecycleFailure {
  if (cause instanceof ConnectionLifecycleFailure) return cause;
  if (cause instanceof ConnectionAccessFailure) return accessFailure(cause);
  if (cause instanceof AccessGrantError) return lifecycleFailure("invalid_access", false, "Access was rejected", cause);
  if (cause instanceof ConnectionError) return lifecycleFailure(cause.code, cause.recoverable, cause.message, cause);
  if (cause instanceof DOMException && cause.name === "NotAllowedError") return lifecycleFailure("permission_denied", true, "Media permission was denied", cause);
  return lifecycleFailure(code, true, message, cause);
}

function accessRejected(cause: unknown): boolean {
  return cause instanceof ConnectionError ? cause.code === "invalid_access" : typeof cause === "object" && cause !== null && "code" in cause && (cause as { readonly code?: unknown }).code === "access.invalid";
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError(`Expected an integer between ${minimum} and ${maximum}`);
  return result;
}

function syncPhase(phase: V1EpisodeSnapshot["connection"]["phase"] | undefined): ConnectionConnectionPhase {
  if (phase === "live") return "healthy";
  if (phase === "recovering") return "recovering";
  if (phase === "terminal") return "failed";
  if (phase === "stopped") return "stopped";
  if (phase === "connecting") return "connecting";
  return "idle";
}

function mediaPhase(phase: CloudflareSFUSnapshot["connection"]["phase"] | undefined): ConnectionConnectionPhase {
  if (phase === "live") return "healthy";
  if (phase === "recovering") return "recovering";
  if (phase === "failed") return "failed";
  if (phase === "stopped") return "stopped";
  if (phase === "connecting") return "connecting";
  return "idle";
}
