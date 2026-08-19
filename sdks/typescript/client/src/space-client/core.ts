import { Clock, Context, Duration, Effect, Layer } from "effect";
import { requireParsedAccessGrant, type AccessGrant, type ParsedAccessGrant } from "../access/grant";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "../connection";
import { ConnectionPlatformService, makeConnectionPlatformLayer, type ConnectionAccessReason, type ConnectionAccessRequest, type ConnectionDependencies, type ConnectionSyncClient } from "../connection/dependencies";
import type { ConnectionDiagnostic } from "../connection/diagnostics";
import { createDefaultConnectionDependencies } from "../connection/production";
import { makeControllerEffects, type ControllerEffects } from "./controller-effects";
import { normalizeClientError, SpaceClientError } from "./errors";
import { MediaDeviceSelection } from "./media-device-selection";
import { SpaceStore, SpaceStoreService, makeSpaceStoreLayer } from "./store";
import type { ClientEventHandler, ClientEventMap, ClientEventName, JoinOptions, SpaceClientOptions, SpaceSnapshot } from "./types";
import type { JourneyTelemetryContext } from "../telemetry/types";
import { EpisodeDiagnosticRuntime, type EpisodeDiagnosticOperation } from "./episode-diagnostic-runtime";
import {
  episodeDiagnosticsForDependencies,
  registerEpisodeDiagnosticConnection,
  registerEpisodeDiagnosticDependencies,
  registerEpisodeDiagnosticSyncClient,
  unregisterEpisodeDiagnosticConnection,
  unregisterEpisodeDiagnosticDependencies,
  unregisterEpisodeDiagnosticSyncClient,
} from "./episode-diagnostic-registry";
import { registerEpisodeDiagnosticTrack, unregisterEpisodeDiagnosticTrack } from "./episode-diagnostic-render-registry";

type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;
type DiagnosticRemoteTrack = { readonly track: MediaStreamTrack; readonly source: "camera" | "screen" };
export type PlatformConnectionAccess = (request?: ConnectionAccessRequest) => AccessGrant | Promise<AccessGrant>;

export type SpaceClientPlatform = {
  readonly apiBaseUrl?: string;
  readonly syncUrl?: string;
  readonly whiteboardUrl?: string | null;
  readonly dependencies?: Partial<ConnectionDependencies>;
  /** Private adapter seam for runtimes that need the full refresh request. */
  readonly connectionAccess?: PlatformConnectionAccess;
  readonly fetch?: typeof globalThis.fetch;
  readonly randomUUID?: () => string;
  readonly syncStartupTimeoutMs?: number;
  readonly initialMicrophoneEnabled?: boolean;
  readonly initialCameraEnabled?: boolean;
  readonly telemetry?: JourneyTelemetryContext;
  readonly onConnectionDiagnostic?: (event: ConnectionDiagnostic) => void;
};

const syncClientsByDependencies = new WeakMap<ConnectionDependencies, Set<ConnectionSyncClient>>();

export class SpaceClientCoreService extends Context.Service<SpaceClientCoreService, SpaceClientCore>()("@chalk/client/SpaceClientCore") {}

/** Production composition keeps every mutable owner inside a scoped Layer. */
export const makeSpaceClientCoreLayer = (options: SpaceClientOptions, platform: SpaceClientPlatform = {}) => {
  const apiBaseUrl = normalizedBaseUrl(platform.apiBaseUrl ?? options.baseUrl ?? "https://api.chalkmeet.com");
  const syncUrl = platform.syncUrl ?? defaultSyncUrl(apiBaseUrl);
  const baseDependencies = { ...createDefaultConnectionDependencies({ apiBaseURL: apiBaseUrl, syncURL: syncUrl, whiteboardURL: platform.whiteboardUrl }), ...platform.dependencies } satisfies ConnectionDependencies;
  const episodeDiagnostics = new EpisodeDiagnosticRuntime({
    apiBaseUrl,
    createId: platform.randomUUID ?? baseDependencies.createId ?? (() => globalThis.crypto.randomUUID()),
    fetch: platform.fetch,
    now: baseDependencies.clock.now,
    setTimeout: baseDependencies.clock.setTimeout,
    clearTimeout: baseDependencies.clock.clearTimeout,
    release: { id: "chalk-client@4.1.3" },
  });
  const diagnosticSyncClients = new Set<ConnectionSyncClient>();
  const dependencies: ConnectionDependencies = {
    ...baseDependencies,
    createSyncClient: (input) => {
      const syncClient = baseDependencies.createSyncClient(input);
      diagnosticSyncClients.add(syncClient);
      return registerEpisodeDiagnosticSyncClient(syncClient, episodeDiagnostics);
    },
  };
  registerEpisodeDiagnosticDependencies(dependencies, episodeDiagnostics);
  syncClientsByDependencies.set(dependencies, diagnosticSyncClients);
  const lifecycle = makeConnectionLifecycleLayer({
    access: (request) => resolveAccessGrant({ request, diagnostics: episodeDiagnostics, options, platform }),
    apiBaseURL: apiBaseUrl,
    syncURL: syncUrl,
    syncStartupTimeoutMs: platform.syncStartupTimeoutMs,
    initialMicrophoneEnabled: platform.initialMicrophoneEnabled,
    initialCameraEnabled: platform.initialCameraEnabled,
    telemetry: platform.telemetry,
    dependencies,
    diagnostics: {
      onEvent: (event) => {
        platform.onConnectionDiagnostic?.(event);
        options.logger?.debug?.("SpaceClient connection event", { event: event.event, state: event.state, epoch: event.epoch, ...(event.code ? { code: event.code } : {}) });
      },
    },
  });
  return makeSpaceClientCoreLayerFromServices(options, platform).pipe(Layer.provideMerge(Layer.mergeAll(makeSpaceStoreLayer, lifecycle, makeConnectionPlatformLayer(dependencies), liveClock(dependencies)))) as Layer.Layer<SpaceClientCoreService, never>;
};

/** Composes the core from replaceable native lifecycle/platform/store Layers. */
export const makeSpaceClientCoreLayerFromServices = (options: SpaceClientOptions, platform: SpaceClientPlatform = {}) =>
  Layer.effect(
    SpaceClientCoreService,
    Effect.gen(function* () {
      const store = yield* Effect.service(SpaceStoreService);
      const lifecycle = yield* Effect.service(ConnectionLifecycleService);
      const dependencies = yield* Effect.service(ConnectionPlatformService);
      const space = options.space.trim();
      if (space.length === 0) return yield* Effect.die(new TypeError("A Space slug is required"));
      if (typeof options.getAccess !== "function") return yield* Effect.die(new TypeError("getAccess is required"));
      const apiBaseUrl = normalizedBaseUrl(platform.apiBaseUrl ?? options.baseUrl ?? "https://api.chalkmeet.com");
      const selection = new MediaDeviceSelection(dependencies.mediaDevices);
      const episodeDiagnostics = episodeDiagnosticsForDependencies(dependencies);
      if (episodeDiagnostics) registerEpisodeDiagnosticConnection(lifecycle, episodeDiagnostics);
      const controllers = yield* makeControllerEffects({ apiBaseUrl, connection: lifecycle, store, mediaDeviceSelection: selection, featureFactories: dependencies, fetch: platform.fetch, episodeDiagnostics });
      return yield* Effect.acquireRelease(
        Effect.sync(() => new SpaceClientCore(lifecycle, selection, store, controllers, episodeDiagnostics, dependencies, syncClientsByDependencies.get(dependencies))),
        (core) => Effect.sync(() => core.dispose()),
      );
    }),
  );

export class SpaceClientCore {
  readonly controllers: ControllerEffects;
  readonly #connection: ConnectionLifecycleCapability;
  readonly #store: SpaceStore;
  readonly #episodeDiagnostics: EpisodeDiagnosticRuntime | undefined;
  readonly #episodeDiagnosticDependencies: ConnectionDependencies | undefined;
  readonly #episodeDiagnosticSyncClients: ReadonlySet<ConnectionSyncClient> | undefined;
  readonly #episodeDiagnosticTracks = new Map<string, DiagnosticRemoteTrack>();
  readonly #handlers: { [TEvent in ClientEventName]: Set<ClientEventHandler<TEvent>> } = { participantJoined: new Set(), participantLeft: new Set(), episodeEnded: new Set(), screenShareStarted: new Set(), screenShareStopped: new Set(), error: new Set() };
  #disposed = false;
  #previous: SpaceSnapshot;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeStore: (() => void) | null = null;
  #unsupportedReported = false;
  #leaveOperation: EpisodeDiagnosticOperation | undefined;
  #participantJoinOperation: EpisodeDiagnosticOperation | undefined;
  #syncConnectOperation: EpisodeDiagnosticOperation | undefined;

  constructor(
    connection: ConnectionLifecycleCapability,
    _selection: MediaDeviceSelection,
    store: SpaceStore,
    controllers: ControllerEffects,
    episodeDiagnostics?: EpisodeDiagnosticRuntime,
    episodeDiagnosticDependencies?: ConnectionDependencies,
    episodeDiagnosticSyncClients?: ReadonlySet<ConnectionSyncClient>,
  ) {
    this.#connection = connection;
    this.#store = store;
    this.controllers = controllers;
    this.#episodeDiagnostics = episodeDiagnostics;
    this.#episodeDiagnosticDependencies = episodeDiagnosticDependencies;
    this.#episodeDiagnosticSyncClients = episodeDiagnosticSyncClients;
    this.#store.updateConnection(connection.getSnapshot());
    this.#previous = this.#store.getSnapshot();
    this.#unsubscribeStore = this.#store.subscribe(() => this.#publishStore());
    this.#unsubscribeConnection = connection.subscribe(() => {
      this.#store.updateConnection(connection.getSnapshot());
      this.#publishConnectionDiagnostics();
    });
    this.#publishConnectionDiagnostics();
  }

  getSnapshot = (): SpaceSnapshot => this.#store.getSnapshot();
  get changes() {
    return this.#store.changes;
  }
  subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener);
  join(options: JoinOptions = {}): ClientEffect<void> {
    this.#participantJoinOperation = this.#episodeDiagnostics?.startOperation("participant.join");
    this.#syncConnectOperation = this.#episodeDiagnostics?.startOperation("sync.connect");
    return Effect.sync(() => this.#requireActive()).pipe(
      Effect.tap(() => Effect.sync(() => this.controllers.media.configure(options))),
      Effect.andThen(this.#connection.configureJoin(options)),
      Effect.andThen(this.#connection.join()),
      Effect.andThen(options.displayName === undefined ? Effect.void : this.controllers.participants.renameSelf(options.displayName)),
      Effect.tap(() =>
        Effect.sync(() => {
          this.#participantJoinOperation?.succeed();
          this.#syncConnectOperation?.succeed();
        }),
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          this.#participantJoinOperation?.fail("join_failed");
          this.#syncConnectOperation?.fail("connect_failed");
        }),
      ),
      Effect.mapError(normalizeClientError),
    );
  }
  leave(): ClientEffect<void> {
    this.#leaveOperation = this.#episodeDiagnostics?.startOperation("participant.leave");
    return this.#connection.leave().pipe(
      Effect.tap(() => Effect.sync(() => this.#leaveOperation?.succeed())),
      Effect.tapError(() => Effect.sync(() => this.#leaveOperation?.fail("leave_failed"))),
      Effect.mapError(normalizeClientError),
    );
  }
  endEpisode(): ClientEffect<void> {
    return trackedEffect(
      this.#episodeDiagnostics,
      "episode.end.authorized",
      this.#connection.runCommand(({ sync }) => foreign(() => sync.endEpisode()).pipe(Effect.tap(() => this.#connection.confirmEpisodeEnded))),
    ).pipe(Effect.asVoid, Effect.mapError(normalizeClientError));
  }
  extendEpisode(minutes: number): ClientEffect<void> {
    return trackedEffect(
      this.#episodeDiagnostics,
      "episode.deadline.extend",
      this.#connection.runCommand(({ sync }) => foreign(() => sync.extendEpisode(minutes))),
    ).pipe(Effect.asVoid, Effect.mapError(normalizeClientError));
  }
  on<TEvent extends ClientEventName>(event: TEvent, handler: ClientEventHandler<TEvent>): () => void {
    this.#handlers[event].add(handler);
    return () => this.#handlers[event].delete(handler);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeConnection?.();
    this.#unsubscribeStore?.();
    this.#unsubscribeConnection = null;
    this.#unsubscribeStore = null;
    this.#disposeDiagnostics();
    this.#clearHandlers();
  }
  #disposeDiagnostics(): void {
    const diagnostics = this.#episodeDiagnostics;
    if (!diagnostics) return;
    this.#unregisterDiagnosticSyncClients(diagnostics);
    this.#unregisterDiagnosticTracks(diagnostics);
    this.#unregisterDiagnosticDependencies(diagnostics);
    unregisterEpisodeDiagnosticConnection(this.#connection, diagnostics);
    diagnostics.dispose();
  }
  #unregisterDiagnosticSyncClients(diagnostics: EpisodeDiagnosticRuntime): void {
    for (const syncClient of this.#episodeDiagnosticSyncClients ?? []) unregisterEpisodeDiagnosticSyncClient(syncClient, diagnostics);
  }
  #unregisterDiagnosticTracks(diagnostics: EpisodeDiagnosticRuntime): void {
    for (const { track } of this.#episodeDiagnosticTracks.values()) unregisterEpisodeDiagnosticTrack(track, diagnostics);
    this.#episodeDiagnosticTracks.clear();
  }
  #unregisterDiagnosticDependencies(diagnostics: EpisodeDiagnosticRuntime): void {
    const dependencies = this.#episodeDiagnosticDependencies;
    if (!dependencies) return;
    unregisterEpisodeDiagnosticDependencies(dependencies, diagnostics);
    syncClientsByDependencies.delete(dependencies);
  }
  #clearHandlers(): void {
    for (const handlers of Object.values(this.#handlers)) handlers.clear();
  }
  #publishStore(): void {
    const previous = this.#previous;
    const next = this.#store.getSnapshot();
    if (previous === next) return;
    this.#previous = next;
    if (this.#episodeDiagnostics) this.#syncDiagnosticTracks(next.media.remote, this.#episodeDiagnostics);
    this.#emitChanges(previous, next);
  }
  #syncDiagnosticTracks(remote: SpaceSnapshot["media"]["remote"], diagnostics: EpisodeDiagnosticRuntime): void {
    const current = diagnosticTracksFor(remote);
    for (const [key, previousTrack] of this.#episodeDiagnosticTracks) {
      if (sameDiagnosticTrack(current.get(key), previousTrack)) continue;
      this.#episodeDiagnosticTracks.delete(key);
      this.#unregisterDiagnosticTrackIfUnused(previousTrack.track, diagnostics);
    }
    for (const [key, currentTrack] of current) {
      if (sameDiagnosticTrack(this.#episodeDiagnosticTracks.get(key), currentTrack)) continue;
      registerEpisodeDiagnosticTrack(currentTrack.track, currentTrack.source, diagnostics);
      this.#episodeDiagnosticTracks.set(key, currentTrack);
    }
  }
  #unregisterDiagnosticTrackIfUnused(track: MediaStreamTrack, diagnostics: EpisodeDiagnosticRuntime): void {
    for (const retained of this.#episodeDiagnosticTracks.values()) if (retained.track === track) return;
    unregisterEpisodeDiagnosticTrack(track, diagnostics);
  }
  #publishConnectionDiagnostics(): void {
    const snapshot = this.#connection.getSnapshot();
    if (!this.#episodeDiagnostics || snapshot.state !== "live") return;
    if (!this.#unsupportedReported) {
      this.#unsupportedReported = true;
      const unsupported = this.#episodeDiagnostics.startOperation("whiteboard.unsupported");
      unsupported?.succeed({ status: "unsupported" });
    }
    if (!this.#participantJoinOperation) {
      this.#participantJoinOperation = this.#episodeDiagnostics.startOperation("participant.join");
      this.#participantJoinOperation?.succeed({ status: "live" });
    }
    if (!this.#syncConnectOperation) {
      this.#syncConnectOperation = this.#episodeDiagnostics.startOperation("sync.connect");
      this.#syncConnectOperation?.succeed({ status: "live" });
    }
  }
  #emitChanges(previous: SpaceSnapshot, next: SpaceSnapshot): void {
    this.#emitParticipantChanges(previous, next);
    this.#emitEpisodeEnd(previous, next);
    this.#emitScreenShareChanges(previous, next);
    this.#emitErrorChange(previous, next);
  }
  #emitParticipantChanges(previous: SpaceSnapshot, next: SpaceSnapshot): void {
    const before = new Map(previous.participants.roster.map((participant) => [participant.participantId, participant]));
    const after = new Map(next.participants.roster.map((participant) => [participant.participantId, participant]));
    for (const participant of after.values()) if (!before.has(participant.participantId)) this.#emit("participantJoined", { participant });
    for (const participant of before.values()) if (!after.has(participant.participantId)) this.#emit("participantLeft", { participant });
  }
  #emitEpisodeEnd(previous: SpaceSnapshot, next: SpaceSnapshot): void {
    if (previous.connection.lastError?.code !== "episode.ended" && next.connection.lastError?.code === "episode.ended") this.#emit("episodeEnded", { episode: previous.connection.episode ?? next.connection.episode });
  }
  #emitScreenShareChanges(previous: SpaceSnapshot, next: SpaceSnapshot): void {
    const previousShares = screenShares(previous);
    const nextShares = screenShares(next);
    for (const participantId of nextShares) if (!previousShares.has(participantId)) this.#emit("screenShareStarted", { participantId });
    for (const participantId of previousShares) if (!nextShares.has(participantId)) this.#emit("screenShareStopped", { participantId });
  }
  #emitErrorChange(previous: SpaceSnapshot, next: SpaceSnapshot): void {
    if (next.connection.lastError && next.connection.lastError !== previous.connection.lastError) this.#emit("error", { error: new SpaceClientError(next.connection.lastError) });
  }
  #emit<TEvent extends ClientEventName>(event: TEvent, value: ClientEventMap[TEvent]): void {
    for (const handler of this.#handlers[event])
      try {
        handler(value);
      } catch {
        /* consumer handlers never own lifecycle */
      }
  }
  #requireActive(): void {
    if (this.#disposed) throw new SpaceClientError({ code: "connection.invalid_state", recoverable: false, message: "The SpaceClient has been disposed" });
  }
}

function liveClock(dependencies: ConnectionDependencies) {
  return Layer.succeed(Clock.Clock, {
    currentTimeMillisUnsafe: dependencies.clock.now,
    currentTimeMillis: Effect.sync(dependencies.clock.now),
    currentTimeNanosUnsafe: () => BigInt(dependencies.clock.now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(dependencies.clock.now()) * 1_000_000n),
    sleep: (duration: Duration.Duration) =>
      Effect.callback((resume) => {
        const handle = dependencies.clock.setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        return Effect.sync(() => dependencies.clock.clearTimeout(handle));
      }),
  });
}
function foreign<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}
function trackedEffect<A, E>(diagnostics: EpisodeDiagnosticRuntime | undefined, name: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  const operation = diagnostics?.startOperation(name);
  return effect.pipe(
    Effect.tap(() => Effect.sync(() => operation?.succeed())),
    Effect.tapError(() => Effect.sync(() => operation?.fail("operation_failed"))),
  );
}

async function resolveAccessGrant(input: { readonly request?: ConnectionAccessRequest; readonly diagnostics: EpisodeDiagnosticRuntime; readonly options: SpaceClientOptions; readonly platform: SpaceClientPlatform }): Promise<ParsedAccessGrant> {
  const { operationName, reason } = diagnosticAccessOperation(input.request);
  const operationBeforeRotation = input.diagnostics.activeContext() ? input.diagnostics.startOperation(operationName, { reason }) : undefined;
  try {
    const grant = await requireParsedAccessGrant(await fetchAccessGrant(input));
    input.diagnostics.rotateCredential(grant.diagnostics ?? null);
    (operationBeforeRotation ?? input.diagnostics.startOperation(operationName, { reason }))?.succeed({ result: "bound" });
    return grant;
  } catch (cause) {
    operationBeforeRotation?.fail("access_failed");
    throw cause;
  }
}

function diagnosticAccessOperation(request: ConnectionAccessRequest | undefined): { readonly operationName: "access.request" | "access.refresh"; readonly reason: ConnectionAccessReason | "join" } {
  const reason = request?.reason ?? "join";
  return { operationName: reason === "join" ? "access.request" : "access.refresh", reason };
}

async function fetchAccessGrant(input: { readonly request?: ConnectionAccessRequest; readonly options: SpaceClientOptions; readonly platform: SpaceClientPlatform }): Promise<unknown> {
  if (input.platform.connectionAccess) return input.platform.connectionAccess(input.request);
  return input.options.getAccess({ space: input.options.space.trim(), reason: accessReason(input.request?.reason) });
}

function accessReason(reason: ConnectionAccessReason | undefined): "join" | "refresh" | "retry" {
  if (reason === undefined || reason === "join") return "join";
  if (reason === "scheduled_refresh") return "refresh";
  return "retry";
}
function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}
function defaultSyncUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.hostname.startsWith("api.")) url.hostname = `sync.${url.hostname.slice(4)}`;
  url.pathname = "/v1/sync";
  return url.toString();
}
function screenShares(snapshot: SpaceSnapshot): ReadonlySet<string> {
  const participants = new Set(snapshot.media.remote.filter((publication) => publication.source === "screen").map((publication) => publication.participantId));
  if (snapshot.media.screenShare.state === "enabled" && snapshot.self.participantId) participants.add(snapshot.self.participantId);
  return participants;
}

function diagnosticTracksFor(remote: SpaceSnapshot["media"]["remote"]): Map<string, DiagnosticRemoteTrack> {
  const tracks = new Map<string, DiagnosticRemoteTrack>();
  for (const publication of remote) {
    if (publication.source !== "camera" && publication.source !== "screen") continue;
    tracks.set(`${publication.participantId}:${publication.source}:${publication.publicationId}`, { track: publication.track, source: publication.source });
  }
  return tracks;
}

function sameDiagnosticTrack(left: DiagnosticRemoteTrack | undefined, right: DiagnosticRemoteTrack): boolean {
  return left?.track === right.track && left?.source === right.source;
}
