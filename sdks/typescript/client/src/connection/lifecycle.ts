import { scheduleForegroundDeadline } from "../foreground-deadline";
import { recordInitialConnection, recordReconnect } from "../telemetry/reconnect";
import { Clock, Context, Data, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Scope, SubscriptionRef } from "effect";
import type { ConnectionMediaSnapshot } from "../media";
import type { V1EpisodeSnapshot } from "../sync";
import { ConnectionAccessFailure, ConnectionAccessService, makeConnectionAccessLayer } from "../access/manager";
import { AccessGrantError, type ParsedAccessGrant } from "../access/grant";
import type { ConnectionLifecycleSnapshot, ConnectionOptions, ConnectionPorts } from "./index";
import { ConnectionDiagnostics, type ConnectionDiagnostic, type ConnectionJoinTraceEvent, type ConnectionJoinTraceStep } from "./diagnostics";
import { ConnectionPlatformService, makeConnectionPlatformLayer, type ConnectionDependencies, type ConnectionMediaClient, type ConnectionSyncClient } from "./dependencies";
import { stopStream, streamFromTracks } from "./media-devices";
import { createDefaultConnectionDependencies } from "./production";
import { ConnectionError, type ConnectionConnectionPhase, type ConnectionFailure, type ConnectionState } from "./types";

// SFU negotiation can take 35s; the lifecycle waiting budget must not cancel its ownership.
const MEDIA_RECOVERY_TIMEOUT_MS = 60_000;
type SyncRecoveryAttempt = { client: ConnectionSyncClient | null; expiresAt: number | null; started: boolean };
type MediaRecoveryAttempt = { expiresAt: number | null };

const START_TIMEOUT_MS = 10_000;
const LEAVE_TIMEOUT_MS = 5_000;
const RECOVERY_BUDGET_MS = 10_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const REFRESH_RETRY_MS = 5_000;
const RECONNECT_GRACE_MS = 250;
const BACKGROUND_RETRY_MAX_MS = 60_000;

type RecoveryKind = "sync" | "media";
type EpisodeControl = NonNullable<V1EpisodeSnapshot["control"]>;
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
  syncNoticeUnresponsive: boolean;
  mediaSnapshot: ConnectionMediaSnapshot | null;
  failure: ConnectionFailure | null;
  initialMedia: InitialMedia;
  intent: { microphone: boolean; camera: boolean };
  episodeEndConfirmed: boolean;
  activeScope: Scope.Closeable | null;
  syncBindingCleanup: (() => void) | null;
  mediaBindingCleanup: (() => void) | null;
  refreshFiber: Fiber.Fiber<void, unknown> | null;
  refreshFailures: number;
  refreshInFlight: boolean;
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
        try: (signal) => Promise.resolve(options.access(request ? { ...request, signal } : undefined)),
        catch: (cause) => (cause instanceof ConnectionAccessFailure ? cause : new ConnectionAccessFailure({ code: accessRejected(cause) ? "access.invalid" : "access.unavailable", cause })),
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
      let emittedSync: ConnectionSyncClient | null = null;
      let foregroundRecoveryDeadline = 0;
      const model: Model = {
        state: "idle",
        sync: null,
        media: null,
        syncSnapshot: null,
        syncNoticeUnresponsive: false,
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
        refreshFailures: 0,
        refreshInFlight: false,
        recoveryQueued: null,
        joinCancelled: false,
        closed: false,
        epoch: 0,
      };

      const mediaAttempt: MediaRecoveryAttempt = { expiresAt: null };
      const foreign = <A>(operation: () => Promise<A>, code: LifecycleFailureCode = "internal_error", message = "A browser transport operation failed"): Effect.Effect<A, ConnectionLifecycleFailure> =>
        Effect.tryPromise({ try: operation, catch: (cause) => lifecycleFailure(code, true, message, cause) });
      const withinForegroundBudget = <A, E>(effect: Effect.Effect<A, E>, milliseconds: number, failure: ConnectionLifecycleFailure): Effect.Effect<A, E | ConnectionLifecycleFailure> =>
        Effect.raceFirst(
          effect,
          Effect.callback<never, ConnectionLifecycleFailure>((resume) => {
            const cancel = scheduleForegroundDeadline(platform.clock, milliseconds, () => resume(Effect.fail(failure)));
            return Effect.sync(cancel);
          }),
        );
      const toPromise = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);
      const publish = (): Effect.Effect<void> =>
        Effect.sync(() => snapshotFor(model, access.currentUnsafe())).pipe(
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
          emittedSync = ports?.sync ?? null;
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
          const scope = model.activeScope;
          if (!active(model) || !scope || model.refreshInFlight) return;
          const epoch = model.epoch;
          model.refreshInFlight = true;
          yield* Effect.forkIn(
            access.ensureFresh("scheduled_refresh").pipe(
              Effect.match({ onSuccess: () => null, onFailure: (cause) => cause }),
              Effect.flatMap((failure) =>
                enqueue(
                  Effect.gen(function* () {
                    if (model.epoch !== epoch || !active(model)) return;
                    model.refreshInFlight = false;
                    if (failure) {
                      diagnostics.record({ event: "access_refresh_failed", state: model.state, epoch, code: failure.code === "access.invalid" ? "invalid_access" : "access_unavailable" });
                      if (failure.code === "access.invalid") return yield* failForSnapshot(accessFailure(failure));
                      model.refreshFailures = Math.min(model.refreshFailures + 1, 5);
                      yield* scheduleRefresh(Math.min(BACKGROUND_RETRY_MAX_MS, REFRESH_RETRY_MS * 2 ** (model.refreshFailures - 1)));
                      return;
                    }
                    model.refreshFailures = 0;
                    diagnostics.record({ event: "access_refreshed", state: model.state, epoch });
                    yield* publish();
                    yield* scheduleRefresh();
                  }),
                ),
              ),
              Effect.ignore,
            ),
            scope,
          );
        });
      const stopPorts = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* stopRefresh();
          const scope = model.activeScope;
          model.activeScope = null;
          model.refreshFailures = 0;
          model.refreshInFlight = false;
          mediaAttempt.expiresAt = null;
          model.sync = null;
          model.media = null;
          model.syncSnapshot = null;
          model.syncNoticeUnresponsive = false;
          model.mediaSnapshot = null;
          model.recoveryQueued = null;
          yield* emitPorts();
          if (scope) yield* Scope.close(scope, Exit.void);
          yield* access.clear;
          yield* publish();
        });
      const bindSync = (scope: Scope.Closeable, sync: ConnectionSyncClient): Effect.Effect<void> =>
        Effect.gen(function* () {
          model.syncBindingCleanup?.();
          model.syncNoticeUnresponsive = false;
          let latestSnapshot: V1EpisodeSnapshot | null = null;
          let snapshotQueued = false;
          const unsubscribe = sync.subscribe((snapshot) => {
            if (sync === model.sync && snapshot.connection.phase === "live") {
              const notice = snapshot.connection.noticeUnresponsive === true;
              if (notice !== model.syncNoticeUnresponsive) {
                model.syncNoticeUnresponsive = notice;
                void Effect.runForkWith(context)(publish());
              }
            }
            latestSnapshot = snapshot;
            if (snapshotQueued) return;
            snapshotQueued = true;
            enqueueBackground(
              Effect.suspend(() => {
                snapshotQueued = false;
                const current = latestSnapshot;
                latestSnapshot = null;
                return current ? handleSyncSnapshot(sync, current) : Effect.void;
              }),
            );
          });
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
          const current = sync.getSnapshot();
          if (current.connection.phase === "live") {
            resume(Effect.void);
            return;
          }
          if (current.connection.phase === "terminal") {
            resume(Effect.fail(syncTerminalFailure(current)));
            return;
          }
          const unsubscribe = sync.subscribe((snapshot) => {
            if (snapshot.connection.phase === "live") resume(Effect.void);
            else if (snapshot.connection.phase === "terminal") resume(Effect.fail(syncTerminalFailure(snapshot)));
            else if (snapshot.connection.phase === "stopped") resume(Effect.fail(lifecycleFailure("sync_start_failed", true, "Sync stopped before becoming live")));
          });
          return Effect.sync(unsubscribe);
        }).pipe((effect) => withinForegroundBudget(effect, timeoutMs, lifecycleFailure("sync_start_failed", true, "Sync did not become live before the startup deadline")));
      const trace = <A, E>(step: Exclude<ConnectionJoinTraceStep, "join">, effect: Effect.Effect<A, E>): Effect.Effect<A, E> => {
        const span = diagnostics.startSpan({ step, state: model.state, epoch: model.epoch });
        return traceRecovery(step, effect, recordInitialConnection).pipe(
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
                    replaceMediaConnection: () =>
                      toPromise(access.refresh("media_recovery", true)).then((replacement) => {
                        if (media === model.media) mediaAttempt.expiresAt = platform.clock.now() + MEDIA_RECOVERY_TIMEOUT_MS;
                        return replacement.media;
                      }),
                    recordReconnect: options.recordReconnect,
                    telemetry: options.telemetry,
                    ...(options.recordRtcSummary ? { recordRtcSummary: options.recordRtcSummary } : {}),
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
                try: () => platform.createSyncClient({ access: grant, token: () => toPromise(access.getSyncToken()), media, telemetry: options.telemetry, recordReconnect: options.recordReconnect }),
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
                  span.end({ state: model.state, epoch: model.epoch, outcome: "failed", code: failure.code });
                  yield* recordFailure(failure);
                  yield* stopPorts();
                  if (!retried && failure.code === "invalid_access") return yield* performJoin("access_retry", true);
                  yield* transition("failed");
                  return yield* Effect.fail(failure);
                }),
              onSuccess: () =>
                Effect.gen(function* () {
                  model.syncSnapshot = model.sync?.getSnapshot() ?? null;
                  model.mediaSnapshot = model.media?.getSnapshot() ?? null;
                  yield* transition("live");
                  if (model.mediaSnapshot?.connection.phase !== "live") yield* recover("media");
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
      const publishFreshAccess = (): Effect.Effect<void> =>
        enqueue(
          Effect.gen(function* () {
            if (!active(model)) return;
            diagnostics.record({ event: "access_refreshed", state: model.state, epoch: model.epoch });
            yield* publish();
            yield* scheduleRefresh();
          }),
        );
      const requireOpen = Effect.suspend(() => (model.closed ? Effect.fail(lifecycleFailure("invalid_state", false, "The Connection scope is closed")) : Effect.void));
      const withFreshAccess = <A, E>(operation: () => Effect.Effect<A, E>): Effect.Effect<A, ConnectionLifecycleFailure | E> =>
        Effect.gen(function* () {
          yield* requireOpen;
          if (yield* access.requiresRefresh) {
            yield* requireOpen;
            yield* access.ensureFresh("scheduled_refresh").pipe(Effect.mapError(accessFailure));
            yield* publishFreshAccess();
          }
          const run = requireOpen.pipe(
            Effect.andThen(Effect.suspend(operation)),
            Effect.flatMap((value) => requireOpen.pipe(Effect.as(value))),
          );
          return yield* run.pipe(
            Effect.matchEffect({
              onSuccess: Effect.succeed,
              onFailure: (cause) => {
                if (!accessRejected(cause)) return Effect.fail(cause);
                return requireOpen.pipe(
                  Effect.andThen(access.refreshAfterRejection()),
                  Effect.mapError((failure) => (failure instanceof ConnectionAccessFailure ? accessFailure(failure) : failure)),
                  Effect.andThen(publishFreshAccess()),
                  Effect.andThen(run),
                );
              },
            }),
          );
        });
      const traceRecovery = <A, E>(step: string, operation: Effect.Effect<A, E>, recordStep = recordReconnect): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          recordStep(options.recordReconnect, step, { boundary: "start" });
          return yield* operation.pipe(
            Effect.onExit((exit) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  recordStep(options.recordReconnect, step, { boundary: "end", duration_ms: Math.max(0, now - started) }, exit._tag === "Success" ? "succeeded" : "failed");
                }),
              ),
            ),
          );
        });
      const recover = (kind: RecoveryKind): Effect.Effect<void> =>
        Effect.gen(function* () {
          const scope = model.activeScope;
          if (!active(model) || !scope) return;
          if (model.recoveryQueued !== null) {
            model.recoveryQueued = kind;
            yield* publish();
            return;
          }
          model.recoveryQueued = kind;
          const phase = kind === "sync" ? model.sync?.getSnapshot().connection.phase : model.media?.getSnapshot().connection.phase;
          if (phase === "terminal" || phase === "failed") yield* transition("reconnecting");
          const epoch = model.epoch;
          yield* Effect.forkIn(
            Effect.gen(function* () {
              yield* Effect.sleep(RECONNECT_GRACE_MS);
              const phase = kind === "sync" ? model.sync?.getSnapshot().connection.phase : model.media?.getSnapshot().connection.phase;
              if (phase === "live") {
                enqueueBackground(finishRecovery(0, epoch));
                return;
              }
              yield* enqueue(
                Effect.gen(function* () {
                  if (model.epoch === epoch && active(model)) yield* transition("reconnecting");
                }),
              );
              let cycle = 0;
              const syncAttempt: SyncRecoveryAttempt = { client: null, expiresAt: null, started: true };
              while (model.epoch === epoch && active(model)) {
                const plan = yield* recoveryPlan(model.recoveryQueued ?? kind);
                const outcome = yield* attemptRecovery(plan, mediaAttempt, syncAttempt).pipe(
                  Effect.match({
                    onSuccess: (attempt) => ({ attempt, failure: null }),
                    onFailure: (failure) => ({ attempt: null, failure }),
                  }),
                );
                if (outcome.failure) {
                  const failure = outcome.failure;
                  enqueueBackground(Effect.suspend(() => (model.epoch === epoch && active(model) ? failForSnapshot(failure) : Effect.void)));
                  return;
                }
                if (outcome.attempt !== null) {
                  enqueueBackground(finishRecovery(outcome.attempt, epoch));
                  return;
                }
                yield* enqueue(
                  Effect.gen(function* () {
                    if (model.epoch !== epoch || !active(model)) return;
                    const code = plan.kind === "media" ? "media_recovery_exhausted" : "sync_recovery_exhausted";
                    model.failure = toFailure(lifecycleFailure(code, true, "Connection interrupted. Reconnecting in the background."));
                    diagnostics.record({ event: "recovery_exhausted", state: model.state, epoch, code });
                    yield* publish();
                  }),
                );
                if (model.recoveryQueued !== plan.kind) continue;
                const delay = Math.min(BACKGROUND_RETRY_MAX_MS, 250 * 2 ** cycle);
                cycle = Math.min(cycle + 1, 8);
                yield* Effect.race(Effect.sleep(delay * (0.5 + Math.random() * 0.5)), waitForTransportChange(plan.kind));
              }
            }),
            scope,
          );
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
      const attemptRecovery = (plan: RecoveryPlan, mediaAttempt: MediaRecoveryAttempt, syncAttempt: SyncRecoveryAttempt): Effect.Effect<number | null, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          for (let attempt = 1; attempt <= plan.attempts; attempt += 1) {
            const remaining = plan.deadline - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return null;
            recordReconnect(options.recordReconnect, "attempt", { recovery_kind: plan.kind, attempt });
            diagnostics.record({ event: "recovery_attempt", state: model.state, epoch: model.epoch, attempt });
            const failure = yield* recoveryOperation(mediaAttempt, syncAttempt).pipe(
              Effect.timeout(remaining),
              Effect.catchTag("TimeoutError", () => Effect.fail(lifecycleFailure("sync_start_failed", true, "Connection recovery is still waiting for the transport"))),
              Effect.match({ onSuccess: () => null, onFailure: (cause) => cause }),
            );
            if (failure === null) return attempt;
            if (!failure.recoverable) return yield* Effect.fail(failure);
            if (attempt < plan.attempts) {
              const remaining = Math.max(0, plan.deadline - (yield* Clock.currentTimeMillis));
              yield* traceRecovery("lifecycle_backoff", Effect.sleep(Math.min(recoveryDelay(plan, attempt), remaining)));
            }
          }
          return null;
        });
      const recoveryOperation = (mediaAttempt: MediaRecoveryAttempt, syncAttempt: SyncRecoveryAttempt): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            [recoverSync(syncAttempt), recoverMedia(mediaAttempt)].map((effect) => effect.pipe(Effect.matchEffect({ onSuccess: () => Effect.succeed(null), onFailure: (failure) => (failure.recoverable ? Effect.succeed(failure) : Effect.fail(failure)) }))),
            { concurrency: "unbounded" },
          );
          const failure = results.find((failure) => failure !== null);
          if (failure) return yield* Effect.fail(failure);
        });
      const recoveryDelay = (plan: RecoveryPlan, attempt: number): number => {
        const delay = plan.delays[Math.min(attempt - 1, plan.delays.length - 1)] ?? 0;
        return Number.isFinite(delay) ? Math.max(0, delay) : 0;
      };
      const finishRecovery = (attempt: number, epoch: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (model.epoch !== epoch || !active(model)) return;
          model.recoveryQueued = null;
          model.syncSnapshot = model.sync?.getSnapshot() ?? null;
          model.mediaSnapshot = model.media?.getSnapshot() ?? null;
          model.failure = null;
          if (model.syncSnapshot?.connection.phase !== "live") return yield* recover("sync");
          if (model.mediaSnapshot?.connection.phase !== "live") return yield* recover("media");
          mediaAttempt.expiresAt = null;
          if (model.sync !== emittedSync) yield* emitPorts();
          diagnostics.record({ event: "recovery_succeeded", state: model.state, epoch, attempt });
          yield* transition("live");
          yield* publish();
          yield* scheduleRefresh();
        });
      const waitForTransportChange = (kind: RecoveryKind): Effect.Effect<void> =>
        Effect.callback((resume) => {
          const sync = model.sync;
          const media = model.media;
          const syncPhase = sync?.getSnapshot().connection.phase;
          const mediaPhase = media?.getSnapshot().connection.phase;
          const observe = () => {
            if (model.recoveryQueued !== kind || model.sync !== sync || model.media !== media || model.sync?.getSnapshot().connection.phase !== syncPhase || model.media?.getSnapshot().connection.phase !== mediaPhase || (syncPhase === "live" && mediaPhase === "live")) resume(Effect.void);
          };
          listeners.add(observe);
          const unsubscribeSync = sync?.subscribe(observe);
          const unsubscribeMedia = media?.subscribe(observe);
          observe();
          return Effect.sync(() => {
            listeners.delete(observe);
            unsubscribeSync?.();
            unsubscribeMedia?.();
          });
        });
      const waitForMediaLive = (media: ConnectionMediaClient): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.callback((resume) => {
          const observe = () => {
            const snapshot = media.getSnapshot();
            if (snapshot.connection.phase === "live") resume(Effect.void);
            else if (snapshot.connection.phase === "failed") resume(Effect.fail(lifecycleFailure("media_start_failed", snapshot.failure?.recoverable ?? true, "Media transport needs recovery")));
          };
          const unsubscribe = media.subscribe(observe);
          observe();
          return Effect.sync(unsubscribe);
        });
      const recoverMedia = (attempt: MediaRecoveryAttempt): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          const media = model.media;
          if (!media) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Media recovery requires active ports"));
          if (media.getSnapshot().connection.phase === "live") {
            attempt.expiresAt = null;
            return;
          }
          if (media.getSnapshot().connection.phase === "recovering") {
            const now = yield* Clock.currentTimeMillis;
            attempt.expiresAt ??= now + MEDIA_RECOVERY_TIMEOUT_MS;
            attempt.expiresAt = Math.max(attempt.expiresAt, foregroundRecoveryDeadline);
            if (typeof document !== "undefined" && document.visibilityState === "hidden") attempt.expiresAt = now + MEDIA_RECOVERY_TIMEOUT_MS;
            if (now < attempt.expiresAt) return yield* waitForMediaLive(media);
          }
          recordReconnect(options.recordReconnect, "media_decision", { strategy: "full_rebuild" });
          const grant = yield* traceRecovery("access_refresh", access.refresh("media_recovery", true).pipe(Effect.mapError(accessFailure)));
          const restartInput = grant.media.provider === "cloudflare_sfu" ? grant.media.clientPayload : grant.media;
          attempt.expiresAt = (yield* Clock.currentTimeMillis) + MEDIA_RECOVERY_TIMEOUT_MS;
          yield* traceRecovery(
            "media_rebuild",
            foreign(() => media.restart(restartInput), "media_start_failed", "Media transport could not restart"),
          );
          yield* waitForMediaLive(media);
        });
      const syncAttemptExpired = (attempt: SyncRecoveryAttempt, sync: ConnectionSyncClient, now: number): boolean => {
        if (attempt.client !== sync) {
          attempt.client = sync;
          attempt.expiresAt = now + MEDIA_RECOVERY_TIMEOUT_MS;
          attempt.started = true;
        }
        attempt.expiresAt = Math.max(attempt.expiresAt ?? 0, foregroundRecoveryDeadline);
        if (typeof document !== "undefined" && document.visibilityState === "hidden") attempt.expiresAt = now + MEDIA_RECOVERY_TIMEOUT_MS;
        return now >= attempt.expiresAt && sync.getSnapshot().connection.phase !== "live";
      };
      const syncNeedsReplacement = (snapshot: V1EpisodeSnapshot): Effect.Effect<boolean, ConnectionLifecycleFailure> => {
        if (snapshot.connection.phase === "idle" || snapshot.connection.phase === "stopped") return Effect.succeed(true);
        if (snapshot.connection.phase !== "terminal") return Effect.succeed(false);
        const failure = syncTerminalFailure(snapshot);
        return failure.recoverable ? Effect.succeed(true) : Effect.fail(failure);
      };
      const recoverSync = (attempt: SyncRecoveryAttempt): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          const sync = model.sync;
          if (!sync) return yield* restartSync(attempt);
          const snapshot = sync.getSnapshot();
          const now = yield* Clock.currentTimeMillis;
          if (syncAttemptExpired(attempt, sync, now)) {
            if (!attempt.started || !sync.restartTransport) return yield* restartSync(attempt);
            sync.restartTransport();
            attempt.expiresAt = now + MEDIA_RECOVERY_TIMEOUT_MS;
          }
          if ((attempt.started || snapshot.connection.phase !== "idle") && (yield* syncNeedsReplacement(snapshot))) return yield* restartSync(attempt);
          // V1 Sync owns reconnect and durable receipts; only custom terminal or
          // unsuccessful replacement transports need a new client.
          yield* waitForSyncLive(sync, boundedInteger(options.recovery?.budgetMs, RECOVERY_BUDGET_MS, 1, 60_000));
        });

      const restartSync = (attempt: SyncRecoveryAttempt): Effect.Effect<void, ConnectionLifecycleFailure> =>
        Effect.gen(function* () {
          const epoch = model.epoch;
          yield* access.getSyncToken("sync_recovery").pipe(Effect.mapError(accessFailure));
          const sync = yield* enqueue(
            Effect.gen(function* () {
              const media = model.media;
              const scope = model.activeScope;
              const grant = access.currentUnsafe();
              if (model.epoch !== epoch || !active(model) || !media || !scope || !grant) return yield* Effect.fail(lifecycleFailure("invalid_state", false, "Sync recovery requires active ports"));
              model.syncBindingCleanup?.();
              model.sync = null;
              const sync = yield* Effect.try({
                try: () => platform.createSyncClient({ access: grant, token: () => toPromise(access.getSyncToken()), media, telemetry: options.telemetry, recordReconnect: options.recordReconnect }),
                catch: (cause) => lifecycleFailure("sync_start_failed", true, "The sync layer could not start", cause),
              });
              model.sync = sync;
              yield* bindSync(scope, sync);
              return sync;
            }),
          );
          attempt.client = sync;
          attempt.started = false;
          attempt.expiresAt = (yield* Clock.currentTimeMillis) + MEDIA_RECOVERY_TIMEOUT_MS;
          yield* foreign(() =>
            sync.start().then(() => {
              if (sync !== model.sync || model.epoch !== epoch) sync.stop();
              else if (attempt.client === sync) attempt.started = true;
            }),
          ).pipe(
            Effect.tapError(() =>
              enqueue(
                Effect.gen(function* () {
                  if (sync !== model.sync) return;
                  model.syncBindingCleanup?.();
                  model.sync = null;
                  model.syncSnapshot = null;
                  yield* publish();
                }),
              ),
            ),
          );
          yield* waitForSyncLive(sync, boundedInteger(options.recovery?.budgetMs, RECOVERY_BUDGET_MS, 1, 60_000));
          yield* enqueue(emitPorts());
        });

      const handleSyncSnapshot = (sync: ConnectionSyncClient, snapshot: V1EpisodeSnapshot): Effect.Effect<void> =>
        Effect.gen(function* handleSyncSnapshotEffect() {
          if (!isCurrentSyncSnapshot(sync, snapshot)) return;
          model.syncSnapshot = snapshot;
          if (syncSubjectMismatched(access.currentUnsafe()?.subject ?? null, snapshot)) return yield* failForSnapshot(lifecycleFailure("invalid_access", false, "Sync authenticated a different participant subject"));
          if (snapshot.connection.phase === "terminal") {
            const failure = syncTerminalFailure(snapshot);
            if (!failure.recoverable) return yield* failForSnapshot(failure);
          }
          if (episodeEnded(snapshot)) return yield* failForSnapshot(lifecycleFailure("episode_ended", false, "The Episode has ended"));
          if (syncNeedsRecovery(snapshot)) yield* recover("sync");
          yield* publish();
        });
      const isCurrentSyncSnapshot = (sync: ConnectionSyncClient, snapshot: V1EpisodeSnapshot): boolean => sync === model.sync && snapshot !== model.syncSnapshot;
      const syncSubjectMismatched = (subject: NonNullable<ReturnType<typeof access.currentUnsafe>>["subject"] | null, snapshot: V1EpisodeSnapshot): boolean =>
        subject !== null && snapshot.participantId !== null && (subject.participantId !== snapshot.participantId || subject.participantGeneration !== snapshot.participantGeneration);
      const episodeEnded = (snapshot: V1EpisodeSnapshot): boolean => snapshot.control?.status === "ended" || snapshot.optimisticControl?.status === "ended";
      const syncNeedsRecovery = (snapshot: V1EpisodeSnapshot): boolean => active(model) && (snapshot.connection.phase === "connecting" || snapshot.connection.phase === "recovering" || snapshot.connection.phase === "terminal");
      const recordFailure = (failure: ConnectionLifecycleFailure): Effect.Effect<void> =>
        Effect.sync(() => {
          const reason = model.sync?.getSnapshot().connection.terminalReason;
          const terminalReason = reason === "participant_inactive" || reason === "stale_participant_generation" || reason === "episode_ended" ? reason : failure.code;
          diagnostics.record({ event: "connection_failed", state: model.state, epoch: model.epoch, code: failure.code });
          recordReconnect(options.recordReconnect, "terminal_failure", { code: failure.code, terminal_reason: terminalReason }, "failed");
        });
      const failForSnapshot = (failure: ConnectionLifecycleFailure): Effect.Effect<void> =>
        Effect.gen(function* failForSnapshotEffect() {
          model.failure = toFailure(failure);
          yield* recordFailure(failure);
          yield* stopPorts();
          yield* transition("failed");
        });
      const handleMediaSnapshot = (media: ConnectionMediaClient, snapshot: ConnectionMediaSnapshot): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (media !== model.media || media.getSnapshot() !== snapshot) return;
          if (snapshot === model.mediaSnapshot) return;
          model.mediaSnapshot = snapshot;
          if (active(model) && (snapshot.connection.phase === "recovering" || (snapshot.connection.phase === "failed" && snapshot.failure?.recoverable))) yield* recover("media");
          yield* publish();
        });
      const handleMediaFailure = (): Effect.Effect<void> => (model.media ? handleMediaSnapshot(model.media, model.media.getSnapshot()) : Effect.void);
      const applyAutomaticMediaReplacement = (grant: ParsedAccessGrant): Effect.Effect<void> =>
        Effect.gen(function* () {
          const media = model.media;
          const scope = model.activeScope;
          const epoch = model.epoch;
          if (!media || !scope || !active(model)) return;
          const restartInput = grant.media.provider === "cloudflare_sfu" ? grant.media.clientPayload : grant.media;
          mediaAttempt.expiresAt = (yield* Clock.currentTimeMillis) + MEDIA_RECOVERY_TIMEOUT_MS;
          yield* Effect.forkIn(
            foreign(
              () =>
                media.restart(restartInput).then(() => {
                  if (media !== model.media || model.epoch !== epoch) media.stop();
                }),
              "media_start_failed",
              "The media client could not apply a replacement access grant",
            ).pipe(
              (effect) => withinForegroundBudget(effect, MEDIA_RECOVERY_TIMEOUT_MS, lifecycleFailure("media_start_failed", true, "Automatic media replacement did not finish")),
              Effect.match({ onSuccess: () => true, onFailure: () => false }),
              Effect.flatMap((restarted) =>
                enqueue(
                  Effect.gen(function* () {
                    if (model.epoch !== epoch || media !== model.media || !active(model)) return;
                    if (!restarted) {
                      yield* recover("media");
                      return;
                    }
                    model.mediaSnapshot = media.getSnapshot();
                    yield* publish();
                  }),
                ),
              ),
            ),
            scope,
          );
        });
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
      const accessReplacementUnsubscribe = yield* access.subscribeAutomaticMediaReplacement((grant) => enqueueBackground(applyAutomaticMediaReplacement(grant)));
      const foregroundUnsubscribe =
        platform.subscribeForeground?.(() => {
          foregroundRecoveryDeadline = platform.clock.now() + MEDIA_RECOVERY_TIMEOUT_MS;
          enqueueBackground(refreshAccess());
        }) ?? null;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          model.closed = true;
          accessReplacementUnsubscribe();
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
        runCommand: <A, E>(operation: (ports: ConnectionPorts) => Effect.Effect<A, E>) =>
          enqueue(
            Effect.gen(function* () {
              const ports = portsFor(model);
              if (!active(model) || !ports || ports.sync.getSnapshot().connection.phase !== "live") return yield* Effect.fail(lifecycleFailure("invalid_state", true, "Connection interrupted. Try again when reconnected."));
              return ports;
            }),
          ).pipe(
            Effect.flatMap((ports) =>
              withFreshAccess(() =>
                Effect.suspend<A, E | ConnectionLifecycleFailure, never>(() => {
                  if (!active(model) || ports.sync !== model.sync) return Effect.fail(lifecycleFailure("invalid_state", true, "Connection interrupted. Try again when reconnected."));
                  return operation(ports).pipe(Effect.flatMap((value) => (active(model) && ports.sync === model.sync ? Effect.succeed(value) : Effect.fail(lifecycleFailure("invalid_state", true, "The command belongs to an inactive Connection")))));
                }),
              ),
            ),
          ),
        runPortCommand: (operation) => withFreshAccess(operation),
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

function snapshotFor(model: Model, access: ParsedAccessGrant | null): ConnectionLifecycleSnapshot {
  const control = model.syncSnapshot?.optimisticControl ?? model.syncSnapshot?.control;
  return Object.freeze({
    state: model.state,
    subject: subjectFor(access),
    episode: episodeFor(access, control),
    connection: Object.freeze({ sync: model.syncSnapshot?.connection.phase === "live" && model.syncNoticeUnresponsive ? "unresponsive" : syncPhase(model.syncSnapshot?.connection.phase), media: mediaPhase(model.mediaSnapshot?.connection.phase) }),
    failure: model.failure ? Object.freeze({ ...model.failure }) : null,
  });
}

function subjectFor(access: ParsedAccessGrant | null): ConnectionLifecycleSnapshot["subject"] {
  if (!access) return null;
  return Object.freeze({ ...access.subject });
}

function episodeFor(access: ParsedAccessGrant | null, control: EpisodeControl | null | undefined): ConnectionLifecycleSnapshot["episode"] {
  if (!access) return null;
  return Object.freeze({
    id: access.subject.episodeId,
    startedAt: access.episodeStartedAt ?? null,
    deadline: control ? new Date(control.deadlineAtMs).toISOString() : null,
  });
}

function portsFor(model: Model): ConnectionPorts | null {
  return model.sync && model.media ? { sync: model.sync, media: model.media } : null;
}

function active(model: Model): boolean {
  return !model.closed && (model.state === "live" || model.state === "reconnecting");
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

function mediaPhase(phase: ConnectionMediaSnapshot["connection"]["phase"] | undefined): ConnectionConnectionPhase {
  if (phase === "live") return "healthy";
  if (phase === "recovering") return "recovering";
  if (phase === "failed") return "failed";
  if (phase === "stopped") return "stopped";
  if (phase === "connecting") return "connecting";
  return "idle";
}

function syncTerminalFailure(snapshot: V1EpisodeSnapshot): ConnectionLifecycleFailure {
  const reason = snapshot.connection.terminalReason;
  if (reason === "episode_ended") return lifecycleFailure("episode_ended", false, "The Episode has ended");
  if (reason === "participant_inactive" || reason === "stale_participant_generation") return lifecycleFailure("invalid_access", false, "Participant access is no longer valid");
  return lifecycleFailure("sync_start_failed", true, "The Sync transport needs recovery");
}
