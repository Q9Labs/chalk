import { Clock, Context, Deferred, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import type { ConnectionMediaSnapshot, MediaSource } from "../media";
import { describeMediaCaptureError } from "../media/capture-error";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { displayMediaConstraints, screenShareCapture, requireDisplayVideoTrack, stopStream, streamFromTracks } from "../connection/media-devices";
import { ConnectionError } from "../connection/types";
import type { V1DirectedRequest } from "../sync";
import { V1SyncError } from "../sync/v1-error";
import { normalizeMediaError, SpaceClientError } from "./errors";
import type { MediaDeviceSelection } from "./media-device-selection";
import { SpaceStore } from "./store";
import { MediaProjectionMonitor } from "./media-projection-monitor";
import type { IncomingMediaRequest, CameraPreview, MediaSlice, ScreenShareOptions } from "./types";
const MEDIA_SOURCES = ["microphone", "camera", "screen"] as const;
const MEDIA_READY_TIMEOUT_MS = 10000;
type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;
type Fork = (effect: Effect.Effect<void, unknown, Clock.Clock>) => void;
type MediaIntent = { readonly enabled: boolean; readonly revision: number; readonly controlRevision: number; readonly options?: ScreenShareOptions; readonly previousEnabled: boolean };
type SourceResult = { readonly revision: number; readonly status: "confirmed" } | { readonly revision: number; readonly status: "failed"; readonly cause: unknown; cleanup: boolean };
type SourceWorker = {
  desired: MediaIntent;
  result: SourceResult;
  initialRevision: number;
  localEnabled: boolean;
  pause: Promise<void> | null;
  serverSequence: number;
  forcedRevision: number | null;
};
function sourceWorker(enabled: boolean): SourceWorker {
  return { desired: { enabled, revision: 0, controlRevision: -1, previousEnabled: enabled }, result: { revision: 0, status: "confirmed" }, initialRevision: 0, localEnabled: enabled, pause: null, serverSequence: -1, forcedRevision: null };
}
type SyncSnapshot = ReturnType<ConnectionPorts["sync"]["getSnapshot"]>;
type CaptureAction = "join" | "setMicrophoneEnabled" | "setCameraEnabled" | "startScreenShare";
type CaptureRollback = {
  readonly action: CaptureAction;
  readonly cause: unknown;
  readonly fallback: Effect.Effect<void, unknown>;
  readonly media: ConnectionPorts["media"];
  readonly permissionMessage: string;
  readonly prepared: boolean;
  readonly source: MediaSource;
  readonly track: MediaStreamTrack | null;
};
type CameraOwner = {
  readonly result: Deferred.Deferred<MediaStreamTrack, unknown>;
  readonly cancel: () => void;
  references: number;
};
type CameraState =
  | { readonly status: "idle" | "ended" }
  | { readonly status: "capturing"; readonly owner: CameraOwner }
  | { readonly status: "live"; readonly owner: CameraOwner; readonly track: MediaStreamTrack; readonly publication: ConnectionPorts["media"] | "initial" | null; readonly onEnded: () => void };
export type MediaControllerEffects = {
  readonly configure: (
    intent: Readonly<{
      microphone?: boolean;
      camera?: boolean;
    }>,
  ) => void;
  readonly setMicrophoneEnabled: (enabled: boolean) => ClientEffect<void>;
  readonly setCameraEnabled: (enabled: boolean) => ClientEffect<void>;
  /** Borrows the current camera or captures privately. The caller must release the preview. */
  readonly captureCameraPreview: () => ClientEffect<CameraPreview>;
  readonly setScreenShareEnabled: (enabled: boolean, options?: ScreenShareOptions) => ClientEffect<void>;
  readonly selectMicrophone: (deviceId: string) => ClientEffect<void>;
  readonly selectCamera: (deviceId: string) => ClientEffect<void>;
  readonly selectSpeaker: (deviceId: string) => ClientEffect<void>;
  readonly acceptRequest: (requestId: string) => ClientEffect<void>;
  readonly declineRequest: (requestId: string) => ClientEffect<void>;
  readonly dispose: () => void;
};
export class MediaControllerService extends Context.Service<MediaControllerService, MediaControllerEffects>()("@chalk/client/MediaController") {}
/** Scoped media controller: all source work is serialized with Effect semaphores. */
export const makeMediaController = (connection: ConnectionLifecycleCapability, store: SpaceStore, selection: MediaDeviceSelection): Effect.Effect<MediaControllerEffects, never, Clock.Clock | Scope.Scope> =>
  Effect.gen(function* () {
    const [microphone, camera, screen] = yield* Effect.all([Semaphore.make(1), Semaphore.make(1), Semaphore.make(1)]);
    const clock = yield* Clock.Clock;
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<Clock.Clock>();
    const fork: Fork = (effect) => {
      void Effect.runForkWith(context)(Effect.forkIn(effect, scope).pipe(Effect.asVoid) as Effect.Effect<void, never, Clock.Clock>);
    };
    const controller = new MediaControllerRuntime(
      connection,
      store,
      selection,
      new Map([
        ["microphone", microphone],
        ["camera", camera],
        ["screen", screen],
      ]),
      clock.currentTimeMillisUnsafe,
      fork,
    );
    yield* connection.setInitialMedia(
      (intent) => controller.captureInitial(intent),
      () => controller.initialIntent(),
      (media, stream) => controller.startInitial(media, stream),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    controller.refreshDevicesInBackground();
    return controller;
  });
export const makeMediaControllerLayer = (connection: ConnectionLifecycleCapability, store: SpaceStore, selection: MediaDeviceSelection) => Layer.effect(MediaControllerService, makeMediaController(connection, store, selection));
class MediaControllerRuntime implements MediaControllerEffects {
  readonly #connection: ConnectionLifecycleCapability;
  readonly #selection: MediaDeviceSelection;
  readonly #store: SpaceStore;
  readonly #gates: ReadonlyMap<MediaSource, Semaphore.Semaphore>;
  readonly #now: () => number;
  readonly #fork: Fork;
  readonly #tracks = new Map<MediaSource, MediaStreamTrack>();
  readonly #sources: Record<MediaSource, SourceWorker> = { microphone: sourceWorker(true), camera: sourceWorker(true), screen: sourceWorker(false) };
  #syncLive = false;
  #recovering: ReadonlyMap<MediaSource, number> | null = null;
  readonly #pendingSources = new Map<MediaSource, number>();
  readonly #pendingCaptures = new Set<() => void>();
  readonly #readinessChecks = new Set<(failure?: SpaceClientError) => void>();
  readonly #requestGenerations = new Map<string, number>();
  #camera: CameraState = { status: "idle" };
  #requests: readonly IncomingMediaRequest[] = Object.freeze([]);
  #ports: ConnectionPorts | null = null;
  #screenAudioTrack: MediaStreamTrack | null = null;
  #unsubscribeMedia: (() => void) | null = null;
  #unsubscribePause: (() => void) | null = null;
  #unsubscribeRequests: (() => void) | null = null;
  #unsubscribeSync: (() => void) | null = null;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeScreenEnded: (() => void) | null = null;
  #unsubscribePorts: (() => void) | null = null;
  #microphoneWatch: { readonly track: MediaStreamTrack; readonly unsubscribe: () => void } | null = null;
  readonly #projection: MediaProjectionMonitor;
  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, selection: MediaDeviceSelection, gates: ReadonlyMap<MediaSource, Semaphore.Semaphore>, now: () => number, fork: Fork) {
    this.#connection = connection;
    this.#store = store;
    this.#selection = selection;
    this.#gates = gates;
    this.#now = now;
    this.#fork = fork;
    this.#projection = new MediaProjectionMonitor({
      now,
      schedule: connection.scheduleUnsafe,
      cancel: connection.cancelScheduleUnsafe,
      changed: () => this.#publish(),
      report: (event) => connection.recordTransportDiagnostic(event),
      pause: (source, revision) => {
        if (this.#ports) this.#pausePublication(this.#ports, source, revision);
      },
    });
    this.#unsubscribeConnection = connection.subscribe(() => this.#handleConnectionChange());
    this.#unsubscribeScreenEnded = connection.subscribeScreenEnded(() => this.#handleScreenEnded());
    this.#unsubscribePorts = connection.subscribePorts((ports) => this.#bind(ports));
  }
  configure(
    intent: Readonly<{
      microphone?: boolean;
      camera?: boolean;
    }>,
  ): void {
    if (intent.microphone !== undefined) this.#recordIntent("microphone", intent.microphone);
    if (intent.camera !== undefined) this.#recordIntent("camera", intent.camera);
  }
  setMicrophoneEnabled = (enabled: boolean): ClientEffect<void> => this.#set("microphone", enabled);
  setCameraEnabled = (enabled: boolean): ClientEffect<void> => this.#set("camera", enabled);
  captureCameraPreview = (): ClientEffect<CameraPreview> => this.#cameraSource("preview").pipe(Effect.mapError(normalizeMediaError));
  setScreenShareEnabled = (enabled: boolean, options?: ScreenShareOptions): ClientEffect<void> => (enabled ? this.#mediaAction(true, this.#startScreen(options)) : this.#stopScreen());
  selectMicrophone = (deviceId: string): ClientEffect<void> =>
    Effect.sync(() => {
      this.#selection.selectCapture("microphone", deviceId);
      this.#store.select("microphone", deviceId);
    }).pipe(Effect.mapError(normalizeMediaError));
  selectCamera = (deviceId: string): ClientEffect<void> =>
    Effect.sync(() => {
      const changed = this.#store.getSnapshot().media.selection.camera !== deviceId;
      this.#selection.selectCapture("camera", deviceId);
      if (changed && (!this.#sources.camera.localEnabled || !this.#hasTrack("camera"))) {
        this.#transitionCamera({ status: "ended" });
      }
      this.#store.select("camera", deviceId);
    }).pipe(Effect.mapError(normalizeMediaError));
  selectSpeaker = (deviceId: string): ClientEffect<void> =>
    foreign(() => this.#selection.selectSpeaker(deviceId)).pipe(
      Effect.tap(() => Effect.sync(() => this.#store.select("speaker", deviceId))),
      Effect.mapError(normalizeMediaError),
    );
  acceptRequest = (requestId: string): ClientEffect<void> => {
    return Effect.suspend(() => {
      const request = this.#requests.find((candidate) => candidate.requestId === requestId);
      if (!request) return Effect.fail(new SpaceClientError({ code: "media.request_invalid", recoverable: false, message: "The media request is no longer active" }));
      return (request.kind === "unmute" ? this.setMicrophoneEnabled(true) : this.setCameraEnabled(true)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.#removeRequest(requestId);
          }),
        ),
      );
    }).pipe(Effect.mapError(normalizeMediaError));
  };
  declineRequest = (requestId: string): ClientEffect<void> => {
    return Effect.sync(() => {
      this.#removeRequest(requestId);
    }).pipe(Effect.mapError(normalizeMediaError));
  };
  initialIntent(): Readonly<{
    microphone: boolean;
    camera: boolean;
  }> {
    return { microphone: this.#hasConsent("microphone"), camera: this.#hasConsent("camera") };
  }
  captureInitial(intent: Readonly<{ microphone: boolean; camera: boolean }>): Effect.Effect<MediaStream, unknown> {
    for (const source of ["microphone", "camera"] as const) this.#sources[source].initialRevision = this.#sources[source].desired.revision;
    if (!intent.camera) return this.#captureInitial(intent);
    return this.#useCamera(
      (track) =>
        Effect.sync(() => this.#setTrack("camera", track)).pipe(
          Effect.andThen(Effect.suspend(() => (intent.microphone && !this.#hasTrack("microphone") ? this.#captureSource("microphone").pipe(Effect.tap((audio) => Effect.sync(() => this.#setTrack("microphone", audio)))) : Effect.void))),
          Effect.map(() => {
            this.#pauseInitialTracks();
            this.#publish();
            return streamFromTracks([...this.#localTracks().values()]);
          }),
        ),
      (signal) =>
        this.#captureInitial(intent, signal).pipe(
          Effect.map((stream) => {
            const track = stream.getTracks().find((track) => track.kind === "video");
            if (!track) throw new TypeError("Initial capture did not return a camera track");
            return track;
          }),
        ),
    );
  }
  #captureInitial(
    intent: Readonly<{
      microphone: boolean;
      camera: boolean;
    }>,
    signal?: AbortSignal,
  ): Effect.Effect<MediaStream, unknown> {
    if (!intent.microphone && !intent.camera) {
      this.#pauseInitialTracks();
      this.#publish();
      return Effect.succeed(streamFromTracks([...this.#localTracks().values()]));
    }
    return this.#captureStream(
      () => this.#selection.getUserMedia({ audio: intent.microphone, video: intent.camera }),
      (stream) =>
        Effect.try({ try: () => selectInitialTracks(stream, intent), catch: (cause) => cause }).pipe(
          Effect.tap((tracks) =>
            Effect.sync(() => {
              for (const [source, track] of tracks) this.#setTrack(source, track);
              this.#pauseInitialTracks();
              this.#publish();
            }),
          ),
          Effect.tap(() => this.#refreshDevices().pipe(Effect.ignore)),
          Effect.map(() => streamFromTracks([...this.#localTracks().values()])),
          Effect.catch((cause) =>
            Effect.sync(() => {
              stopStream(stream);
              this.#publish();
            }).pipe(Effect.andThen(Effect.fail(captureError(cause, "join", "Camera or microphone permission was denied")))),
          ),
        ),
      (cause) => cause,
      signal,
    ).pipe(Effect.catch((cause) => Effect.fail(cause instanceof ConnectionError ? cause : captureError(cause, "join", "Camera or microphone permission was denied"))));
  }
  refreshDevicesInBackground(): void {
    this.#fork(this.#refreshDevices().pipe(Effect.ignore));
  }
  dispose(): void {
    this.#projection.reset();
    for (const check of this.#readinessChecks) check(normalizeMediaError(cancelledCaptureError()));
    this.#cancelCaptures();
    for (const unsubscribe of [this.#unsubscribeMedia, this.#unsubscribeRequests, this.#unsubscribePause, this.#unsubscribeSync]) unsubscribe?.();
    this.#unsubscribeConnection?.();
    this.#unsubscribeScreenEnded?.();
    this.#unsubscribePorts?.();
    this.#unsubscribeMedia = null;
    this.#unsubscribeRequests = null;
    this.#unsubscribePause = null;
    this.#unsubscribeSync = null;
    this.#unsubscribeConnection = null;
    this.#unsubscribeScreenEnded = null;
    this.#unsubscribePorts = null;
    this.#ports = null;
    this.#resetObservations();
    this.#screenAudioTrack?.stop();
    this.#screenAudioTrack = null;
    for (const track of this.#tracks.values()) track.stop();
    this.#clearTracks();
    this.#clearRequests();
    this.#publish();
  }
  #mediaAction<A, E>(enabling: boolean, operation: Effect.Effect<A, E>): Effect.Effect<A, E | SpaceClientError> {
    return Effect.suspend<A, E | SpaceClientError, never>(() => (!enabling || this.#store.getSnapshot().connection.status === "live" ? operation : Effect.fail(normalizeMediaError(new V1SyncError("Media enable requires a live call", "not_live")))));
  }
  #waitForLive(source: MediaSource, revision: number, ports?: ConnectionPorts): ClientEffect<void> {
    return Effect.suspend(() => {
      let cleanup = () => {};
      return Effect.callback<void, SpaceClientError>((resume) => {
        const check = (failure?: SpaceClientError) => {
          if (failure) return resume(Effect.fail(failure));
          if (this.#sources[source].desired.revision !== revision) return resume(Effect.void);
          if (ports && !this.#canUsePorts(ports)) return resume(Effect.fail(normalizeMediaError(cancelledCaptureError())));
          const state = this.#connection.getSnapshot().state;
          if (state === "live" && this.#ports?.sync.getSnapshot().connection.phase === "live" && this.#store.getSnapshot().connection.status === "live") return resume(Effect.void);
          if (!["joining", "reconnecting", "live"].includes(state)) resume(Effect.fail(normalizeMediaError(new V1SyncError("Media enable requires a live call", "not_live"))));
        };
        this.#readinessChecks.add(check);
        const unsubscribe = this.#connection.subscribe(() => check());
        const unsubscribeStore = this.#store.subscribe(() => check());
        const unsubscribePorts = this.#connection.subscribePorts(() => check());
        const timer = this.#connection.scheduleUnsafe(() => check(new SpaceClientError({ code: "media.timeout", recoverable: true, message: "The call did not connect in time. Try again." })), MEDIA_READY_TIMEOUT_MS);
        cleanup = () => {
          this.#readinessChecks.delete(check);
          unsubscribe();
          unsubscribeStore();
          unsubscribePorts();
          this.#connection.cancelScheduleUnsafe(timer);
        };
        check();
      }).pipe(Effect.ensuring(Effect.sync(() => cleanup())));
    });
  }
  #set(source: "microphone" | "camera", enabled: boolean): ClientEffect<void> {
    return Effect.suspend(() => (this.#store.getSnapshot().connection.status === "joining" ? this.#act(source, enabled) : this.#mediaAction(enabled, this.#act(source, enabled))));
  }
  #startScreen(options?: ScreenShareOptions): ClientEffect<void> {
    return this.#act("screen", true, options);
  }
  #stopScreen(): ClientEffect<void> {
    return this.#act("screen", false);
  }
  #pauseTracks(source: MediaSource): void {
    const track = this.#track(source);
    if (track) track.enabled = false;
    for (const publication of this.#ports?.media.getSnapshot().localTracks ?? []) if (publication.source === source) publication.track.enabled = false;
    if (source === "screen" && this.#screenAudioTrack) this.#screenAudioTrack.enabled = false;
  }
  #retainPause(state: SourceWorker, next: Promise<void>): void {
    const previous = state.pause;
    state.pause = previous
      ? Promise.allSettled([previous, next]).then((results) => {
          for (const result of results) if (result.status === "rejected") throw result.reason;
        })
      : next;
    void state.pause.catch(() => undefined);
  }
  #recordIntent(source: MediaSource, enabled: boolean, options?: ScreenShareOptions): MediaIntent {
    const state = this.#sources[source];
    const controlRevision = Math.max(state.serverSequence, this.#ports?.sync.getSnapshot().control?.revision ?? -1);
    const desired = { enabled, revision: state.desired.revision + 1, controlRevision, options, previousEnabled: state.localEnabled };
    state.desired = desired;
    if (!enabled) {
      state.localEnabled = false;
      this.#pauseTracks(source);
      if (source === "screen") {
        this.#track("screen")?.stop();
        this.#screenAudioTrack?.stop();
      }
      const ports = this.#ports;
      if (ports) {
        ports.media.setLocalSourceIntent?.(source, false);
        this.#retainPause(state, this.#beginLocalPause(ports, source));
      }
    }
    for (const check of this.#readinessChecks) check();
    return desired;
  }
  #act(source: MediaSource, enabled: boolean, options?: ScreenShareOptions): ClientEffect<void> {
    return Effect.suspend(() => {
      if (this.#ports?.media.getSnapshot().connection.phase === "stopped") return Effect.void;
      const desired = this.#recordIntent(source, enabled, options);
      const ready =
        enabled && source !== "screen" && this.#store.getSnapshot().connection.status !== "live"
          ? this.#waitForLive(source, desired.revision).pipe(
              Effect.tapError((cause) =>
                Effect.sync(() => {
                  if (this.#sources[source].desired.revision === desired.revision) {
                    const cancelled = this.#recordIntent(source, false);
                    this.#sources[source].result = { revision: cancelled.revision, status: "failed", cause, cleanup: false };
                  }
                }),
              ),
            )
          : Effect.void;
      return this.#pending(
        source,
        ready.pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (this.#sources[source].desired.revision !== desired.revision) return Effect.void;
              return this.#serialize(source, this.#work(source)).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    const result = this.#sources[source].result;
                    if (result.revision === desired.revision && result.status === "failed") return Effect.fail(result.cause);
                    if (enabled && (source === "screen" || this.#sources[source].desired.enabled) && this.#store.getSnapshot().connection.status !== "live") return this.#mediaAction(true, Effect.void);
                    return Effect.void;
                  }),
                ),
              );
            }),
          ),
        ),
      );
    }).pipe(Effect.mapError(normalizeMediaError));
  }
  #work(source: MediaSource): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const state = this.#sources[source];
      while (state.result.revision !== state.desired.revision || (state.result.status === "failed" && state.result.cleanup)) {
        const intent = state.desired;
        yield* this.#runRevision(source, intent);
        if (state.desired.revision === intent.revision) return;
      }
    });
  }
  #runRevision(source: MediaSource, intent: MediaIntent): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const state = this.#sources[source];
      const pause = state.pause;
      state.pause = null;
      const paused = yield* Effect.exit(pause ? foreign(() => pause) : Effect.void);
      if (state.desired.revision !== intent.revision) return;
      const ports = this.#ports;
      const cleanup = source === "screen" && !intent.enabled ? yield* Effect.exit(this.#stopScreenLocally(ports)) : Exit.succeed(undefined);
      if (state.desired.revision !== intent.revision) return;
      if (ports && this.#syncLive) yield* this.#executeRevision(ports, source, intent);
      // Joining/offline actions never hold a worker while waiting on the lifecycle queue.
      else if (intent.enabled) state.result = { revision: intent.revision, status: "failed", cause: new V1SyncError("Media enable requires a live call", "not_live"), cleanup: !intent.previousEnabled };
      yield* paused;
      yield* cleanup;
    });
  }
  #executeRevision(ports: ConnectionPorts, source: MediaSource, intent: MediaIntent): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const state = this.#sources[source];
      if (state.result.revision === intent.revision && state.result.status === "failed") {
        yield* this.#connection.runCommand((p) => this.#send(p, source, intent, false));
        if (state.result.revision === intent.revision && state.result.status === "failed") state.result.cleanup = false;
        return;
      }
      const operation = source === "screen" ? this.#prepareScreen(ports, intent) : this.#prepareDevice(ports, source, intent);
      const result = yield* Effect.exit(this.#connection.runCommand(() => operation));
      if (state.desired.revision !== intent.revision) return;
      if (Exit.isSuccess(result)) {
        state.result = { revision: intent.revision, status: "confirmed" };
        state.localEnabled = state.forcedRevision === intent.revision ? false : intent.enabled;
      } else {
        const cause = yield* Effect.flip(result);
        yield* this.#failRevision(ports, source, intent, cause);
      }
    });
  }
  #failRevision(ports: ConnectionPorts, source: MediaSource, intent: MediaIntent, cause: unknown): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      const state = this.#sources[source];
      if (!intent.enabled && ports.sync.getSnapshot().connection.phase !== "live") return;
      const previous = intent.previousEnabled;
      // This is the result of this operation, never an inference from a projection.
      // An Off failure cannot undo the user's local pause; its remote cleanup remains pending.
      if (state.desired.revision !== intent.revision) return;
      state.result = { revision: intent.revision, status: "failed", cause, cleanup: !intent.enabled || !previous };
      if (state.result.cleanup) {
        state.localEnabled = false;
        this.#pauseTracks(source);
        ports.media.setLocalSourceIntent?.(source, false);
      }
    });
  }
  #prepareDevice(ports: ConnectionPorts, source: "microphone" | "camera", intent: MediaIntent): Effect.Effect<void, unknown> {
    if (!intent.enabled) return this.#send(ports, source, intent, false);
    let captured: MediaStreamTrack | null = null;
    let prepared = false;
    const action = source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled";
    return this.#mediaAction(
      true,
      Effect.suspend(() => {
        this.#assertCurrentIntent(source, intent.revision);
        ports.media.setLocalSourceIntent?.(source, true);
        const retire = source === "microphone" ? this.#retireEndedMicrophone(ports.media) : Effect.void;
        const acquire = Effect.suspend(() => {
          this.#assertActivePorts(ports, action);
          this.#assertCurrentIntent(source, intent.revision);
          return (source === "camera" && !intent.previousEnabled) || !this.#hasTrack(source)
            ? this.#captureForPublish(source, ports.media, (track) =>
                Effect.sync(() => {
                  captured = track;
                }).pipe(
                  Effect.andThen(this.#waitForLive(source, intent.revision, ports)),
                  Effect.andThen(
                    Effect.try({
                      try: () => {
                        this.#assertActivePorts(ports, action);
                        this.#assertCurrentIntent(source, intent.revision);
                        this.#setTrack(source, track);
                        ports.media.prepareLocalTrack(source, track);
                        prepared = true;
                        this.#publish();
                      },
                      catch: (cause) => cause,
                    }),
                  ),
                ),
              )
            : Effect.void;
        });
        return retire.pipe(Effect.andThen(acquire), Effect.andThen(this.#send(ports, source, intent, true)));
      }),
    ).pipe(Effect.catch((cause) => this.#rollbackCapture({ action, cause, fallback: Effect.void, media: ports.media, permissionMessage: `${source} permission was denied`, prepared, source, track: captured })));
  }
  #stopScreenLocally(ports: ConnectionPorts | null): Effect.Effect<void, unknown> {
    const track = this.#track("screen");
    const clearVideo = ports ? foreign(() => ports.media.clearPreparedLocalTrack("screen")) : Effect.void;
    const clear = ports ? this.#clearScreenAudio(ports.media).pipe(Effect.matchEffect({ onFailure: (cause) => clearVideo.pipe(Effect.andThen(Effect.fail(cause))), onSuccess: () => clearVideo })) : Effect.void;
    return clear.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (this.#track("screen") === track) this.#deleteTrack("screen");
          track?.stop();
          this.#publish();
        }),
      ),
    );
  }
  #prepareScreen(ports: ConnectionPorts, intent: MediaIntent): Effect.Effect<void, unknown> {
    if (!intent.enabled) return this.#send(ports, "screen", intent, false);
    return this.#mediaAction(
      true,
      Effect.suspend(() => {
        this.#assertCurrentIntent("screen", intent.revision);
        ports.media.setLocalSourceIntent?.("screen", true);
        if (this.#hasTrack("screen") && !intent.options) return this.#send(ports, "screen", intent, true);
        let track: MediaStreamTrack | null = null;
        let prepared = false;
        return this.#captureStream(
          () => this.#selection.getDisplayMedia(displayMediaConstraints(intent.options)),
          (stream) =>
            Effect.gen({ self: this }, function* () {
              this.#assertActivePorts(ports, "startScreenShare");
              this.#assertCurrentIntent("screen", intent.revision);
              track = requireDisplayVideoTrack(stream);
              const previous = this.#track("screen");
              if (previous) {
                yield* this.#send(ports, "screen", intent, false);
                yield* this.#clearScreenAudio(ports.media);
                yield* foreign(() => ports.media.clearPreparedLocalTrack("screen"));
                this.#deleteTrack("screen");
                previous.stop();
              }
              this.#assertActivePorts(ports, "startScreenShare");
              this.#assertCurrentIntent("screen", intent.revision);
              const audio = stream.getAudioTracks()[0];
              for (const extra of stream.getAudioTracks().slice(1)) extra.stop();
              ports.media.prepareLocalTrack("screen", track);
              prepared = true;
              this.#setTrack("screen", track);
              this.#screenAudioTrack = audio ?? null;
              if (audio) {
                ports.media.prepareLocalTrack("screen_audio", audio);
                audio.addEventListener("ended", () => this.#handleScreenAudioEnded(audio, ports));
              }
              track.addEventListener("ended", () => this.#handleScreenEnded(track ?? undefined));
              this.#publish();
              yield* this.#send(ports, "screen", intent, true);
            }).pipe(
              Effect.catch((cause) =>
                (prepared ? this.#clearScreenAudio(ports.media) : Effect.void).pipe(
                  Effect.ignore,
                  Effect.andThen(this.#rollbackCapture({ action: "startScreenShare", cause, fallback: Effect.sync(() => stopStream(stream)), media: ports.media, permissionMessage: "Screen sharing permission was denied", prepared, source: "screen", track })),
                ),
              ),
            ),
          (cause) => captureError(cause, "startScreenShare", "Screen sharing permission was denied"),
        );
      }),
    );
  }
  #assertCurrentIntent(source: MediaSource, revision: number, enabling = true): void {
    const state = this.#sources[source];
    if (state.desired.revision !== revision || (enabling && state.forcedRevision === revision)) throw cancelledCaptureError();
  }
  #hasConsent(source: MediaSource): boolean {
    const state = this.#sources[source];
    return state.desired.enabled && state.forcedRevision !== state.desired.revision;
  }
  #resetObservations(): void {
    if (this.#connection.getSnapshot().state !== "reconnecting") this.#recovering = null;
    for (const source of MEDIA_SOURCES) {
      const state = this.#sources[source];
      state.result = { revision: state.desired.revision, status: "confirmed" };
      state.pause = null;
      state.serverSequence = -1;
      // Revocation belongs to the action, not a disposable connection or Sync client.
    }
  }
  #pauseInitialTracks(): void {
    for (const source of ["microphone", "camera"] as const) {
      const enabled = this.#hasConsent(source);
      const track = this.#track(source);
      if (track && !enabled) track.enabled = false;
      this.#sources[source].localEnabled = !!track && enabled;
    }
  }
  startInitial(media: ConnectionPorts["media"], stream: MediaStream): Effect.Effect<void, unknown> {
    const publish = foreign(async () => {
      // Capture and access initialization may yield; inspect intent again at the send boundary.
      const revisions = { microphone: this.#sources.microphone.initialRevision, camera: this.#sources.camera.initialRevision };
      const tracks = stream.getTracks().filter((track) => {
        const source = track.kind === "audio" ? "microphone" : "camera";
        const enabled = this.#hasConsent(source);
        track.enabled = enabled;
        if (!enabled) {
          // An omitted source was never prepared in the media plane. Release its publication ownership.
          this.#deleteTrack(source);
          if (source === "microphone") track.stop();
        }
        return enabled;
      });
      await media.start(streamFromTracks(tracks));
      for (const source of ["microphone", "camera"] as const) {
        const state = this.#sources[source];
        if (state.desired.revision === revisions[source]) state.result = { revision: revisions[source], status: "confirmed" };
      }
    });
    return this.#serialize("microphone", this.#serialize("camera", publish));
  }
  #send(ports: ConnectionPorts, source: MediaSource, intent: MediaIntent, enabled: boolean): Effect.Effect<void, unknown> {
    const command = this.#mediaAction(
      enabled,
      foreign(async () => {
        // Revision check and transport invocation are one synchronous turn, owned by the source worker.
        this.#assertCurrentIntent(source, intent.revision, enabled);
        this.#assertActivePorts(ports, source === "screen" ? "startScreenShare" : source === "camera" ? "setCameraEnabled" : "setMicrophoneEnabled");
        const send = source === "microphone" ? ports.sync.setMicrophoneEnabled : source === "camera" ? ports.sync.setCameraEnabled : ports.sync.setScreenShareEnabled;
        await send.call(ports.sync, enabled);
      }).pipe(
        Effect.andThen(enabled && source !== "screen" ? this.#waitForLive(source, intent.revision, ports) : Effect.void),
        Effect.tap(() => Effect.try({ try: () => this.#assertActivePorts(ports, source === "screen" ? "startScreenShare" : source === "camera" ? "setCameraEnabled" : "setMicrophoneEnabled"), catch: (cause) => cause })),
      ),
    );
    return enabled && source !== "screen" ? this.#waitForLive(source, intent.revision, ports).pipe(Effect.andThen(command)) : command;
  }
  #reconcileIntents(): void {
    const live = this.#connection.getSnapshot().state === "live" && this.#ports?.sync.getSnapshot().connection.phase === "live";
    if (this.#syncLive && !live) this.#rememberRecoveryIntents();
    const resumed = live && !this.#syncLive;
    this.#syncLive = live;
    if (!resumed) return;
    if (this.#ports) this.#pauseRecoveredIntents(this.#ports, this.#ports.sync.getSnapshot());
    this.#resumePendingActions();
  }
  #resumePendingActions(): void {
    for (const source of MEDIA_SOURCES) {
      const state = this.#sources[source];
      // Pending user enables own their readiness wait. Recovery never replays one
      // or sends participant-wide cleanup for a failed enable on another client.
      if (source !== "screen" && (state.desired.enabled || state.result.revision === state.desired.revision)) continue;
      this.#fork(this.#serialize(source, this.#work(source)).pipe(Effect.ignore));
    }
  }
  #clearScreenAudio(media: ConnectionPorts["media"]): Effect.Effect<void, unknown> {
    return foreign(() => media.clearPreparedLocalTrack("screen_audio")).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.#screenAudioTrack?.stop();
          this.#screenAudioTrack = null;
        }),
      ),
    );
  }
  #beginLocalPause(ports: ConnectionPorts, source: MediaSource): Promise<void> {
    const pause = Effect.runPromise(this.#localTarget(ports, source, false));
    // The command gate awaits and propagates this error; observe it meanwhile.
    void pause.catch(() => undefined);
    return pause;
  }
  #serialize<A>(source: MediaSource, effect: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    return this.#gates.get(source)!.withPermit(this.#pending(source, effect));
  }
  #pending<A>(source: MediaSource, effect: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    return Effect.sync(() => {
      this.#pendingSources.set(source, (this.#pendingSources.get(source) ?? 0) + 1);
      this.#publish();
    }).pipe(
      Effect.andThen(effect),
      Effect.ensuring(
        Effect.sync(() => {
          const remaining = this.#pendingSources.get(source)! - 1;
          if (remaining === 0) this.#pendingSources.delete(source);
          else this.#pendingSources.set(source, remaining);
          this.#publish();
        }),
      ),
    );
  }
  #localTarget(ports: ConnectionPorts, source: MediaSource, enabled: boolean): Effect.Effect<void, unknown> {
    return foreign(() => ports.media.setLocalPublicationTarget({ operationId: `privacy-${source}-${enabled ? "restore" : "off"}`, participantId: ports.sync.getSnapshot().participantId ?? "", source, enabled })).pipe(
      Effect.flatMap((result) =>
        result.outcome === "confirmed" || result.outcome === "satisfied" || (!enabled && result.errorCode === "source_unavailable") ? Effect.void : Effect.fail(new SpaceClientError({ code: "media.capture_failed", recoverable: true, message: `Could not ${enabled ? "restore" : "pause"} ${source}` })),
      ),
    );
  }
  #transitionCamera(next: CameraState): void {
    const previous = this.#camera;
    const sameOwner = "owner" in previous && "owner" in next && previous.owner === next.owner;
    if (previous.status === "live") previous.track.removeEventListener("ended", previous.onEnded);
    this.#camera = next;
    if (!sameOwner && "owner" in previous) {
      previous.owner.cancel();
      if (previous.status === "live") previous.track.stop();
    }
    if (next.status === "live") next.track.addEventListener("ended", next.onEnded, { once: true });
    this.#publish();
    this.#retireCameraPublication(previous, next);
  }
  #retireCameraPublication(previous: CameraState, next: CameraState): void {
    if (previous.status !== "live" || previous.publication === null || previous.publication === "initial") return;
    if (next.status === "live" && next.track === previous.track && next.publication !== null) return;
    const media = previous.publication;
    void Promise.resolve()
      .then(() => media.clearPreparedLocalTrack("camera", { stopTrack: false }))
      .then(() => this.#enablePrivateCamera(previous.owner))
      .catch((cause) => Effect.runSync(Effect.logWarning("Camera publication cleanup failed", cause)));
  }
  #enablePrivateCamera(owner: CameraOwner): void {
    const state = this.#camera;
    if (state.status === "live" && state.owner === owner && state.publication === null) state.track.enabled = true;
  }
  #track(source: MediaSource): MediaStreamTrack | undefined {
    if (source !== "camera") return this.#tracks.get(source);
    return this.#camera.status === "live" && this.#camera.publication !== null && this.#camera.track.readyState === "live" ? this.#camera.track : undefined;
  }
  #hasTrack(source: MediaSource): boolean {
    return this.#track(source) !== undefined;
  }
  #localTracks(): Map<MediaSource, MediaStreamTrack> {
    const tracks = new Map(this.#tracks);
    const camera = this.#track("camera");
    if (camera) tracks.set("camera", camera);
    return tracks;
  }
  #setTrack(source: MediaSource, track: MediaStreamTrack): void {
    if (source !== "camera") {
      this.#tracks.set(source, track);
      if (source === "microphone") this.#watchMicrophone(track);
      return;
    }
    const state = this.#camera;
    if (!("owner" in state)) throw cancelledCaptureError();
    if (state.status === "live" && state.track !== track) throw cancelledCaptureError();
    const onEnded = () => {
      if (this.#camera.status === "live" && this.#camera.track === track) this.#transitionCamera({ status: "ended" });
    };
    this.#transitionCamera({ status: "live", owner: state.owner, track, publication: this.#ports?.media ?? "initial", onEnded });
  }
  #watchMicrophone(track: MediaStreamTrack | null): void {
    if (this.#microphoneWatch?.track === track) return;
    this.#microphoneWatch?.unsubscribe();
    this.#microphoneWatch = null;
    if (!track) return;
    const changed = () => {
      if (this.#microphoneWatch?.track !== track) return;
      if (track.muted || track.readyState === "ended") {
        track.enabled = false;
        const state = this.#sources.microphone;
        if (this.#ports) this.#pausePublication(this.#ports, "microphone", state.desired.revision);
        else {
          state.forcedRevision = state.desired.revision;
          state.localEnabled = false;
        }
      }
      this.#publish();
    };
    for (const event of ["mute", "unmute", "ended"]) track.addEventListener(event, changed);
    this.#microphoneWatch = {
      track,
      unsubscribe: () => {
        for (const event of ["mute", "unmute", "ended"]) track.removeEventListener(event, changed);
      },
    };
    if (track.muted || track.readyState === "ended") changed();
  }
  #deleteTrack(source: MediaSource): void {
    if (source !== "camera") {
      if (source === "microphone") {
        this.#watchMicrophone(null);
      }
      this.#tracks.delete(source);
      return;
    }
    const state = this.#camera;
    if (state.status !== "live") return;
    if (state.owner.references > 0 && state.track.readyState === "live") {
      this.#transitionCamera({ ...state, publication: null });
    } else this.#transitionCamera({ status: "ended" });
  }
  #clearTracks(): void {
    this.#watchMicrophone(null);
    this.#tracks.clear();
    this.#transitionCamera({ status: "idle" });
  }
  #cameraSource(purpose: "preview" | "publication", acquire: (signal: AbortSignal) => Effect.Effect<MediaStreamTrack, unknown> = (signal) => this.#captureSource("camera", signal)): Effect.Effect<CameraPreview, unknown> {
    return Effect.suspend(() => {
      this.#discardEndedCamera();
      const current = this.#camera;
      if (current.status === "live") return this.#liveCameraSource(current, purpose);
      if (current.status === "capturing") return this.#borrowCamera(current.owner);
      return this.#borrowCamera(this.#beginCameraCapture(acquire));
    });
  }
  #discardEndedCamera(): void {
    if (this.#camera.status === "live" && this.#camera.track.readyState !== "live") this.#transitionCamera({ status: "ended" });
  }
  #retireEndedMicrophone(media: ConnectionPorts["media"]): Effect.Effect<void, unknown> {
    const track = this.#tracks.get("microphone");
    if (track?.readyState !== "ended") return Effect.void;
    // The media client refuses to prepare a source that still holds the ended track.
    return foreign(() => media.clearPreparedLocalTrack("microphone", { stopTrack: false })).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (this.#tracks.get("microphone") === track) this.#tracks.delete("microphone");
        }),
      ),
    );
  }
  #liveCameraSource(current: CameraState & { readonly status: "live" }, purpose: "preview" | "publication"): Effect.Effect<CameraPreview, unknown> {
    if (current.publication !== null && !current.track.enabled && purpose === "preview") {
      const track = current.track.clone();
      track.enabled = true;
      const release = () => {
        this.#pendingCaptures.delete(release);
        track.stop();
      };
      this.#pendingCaptures.add(release);
      return Effect.succeed({ track, release });
    }
    return this.#borrowCamera(current.owner);
  }
  #beginCameraCapture(acquire: (signal: AbortSignal) => Effect.Effect<MediaStreamTrack, unknown>): CameraOwner {
    const abort = new AbortController();
    const owner: CameraOwner = {
      result: Deferred.makeUnsafe<MediaStreamTrack, unknown>(),
      references: 0,
      cancel: () => {
        abort.abort();
        Deferred.doneUnsafe(owner.result, Effect.fail(cancelledCaptureError()));
      },
    };
    this.#transitionCamera({ status: "capturing", owner });
    this.#fork(
      acquire(abort.signal).pipe(
        Effect.tap((track) =>
          Effect.try({
            try: () => {
              const state = this.#camera;
              if (abort.signal.aborted || !("owner" in state) || state.owner !== owner) {
                track.stop();
                throw cancelledCaptureError();
              }
              const onEnded = () => {
                if (this.#camera.status === "live" && this.#camera.owner === owner) this.#transitionCamera({ status: "ended" });
              };
              this.#transitionCamera({ status: "live", owner, track, publication: state.status === "live" ? state.publication : null, onEnded });
              if (track.readyState !== "live") {
                this.#transitionCamera({ status: "ended" });
                throw cancelledCaptureError();
              }
            },
            catch: (cause) => cause,
          }),
        ),
        Effect.onExit((exit) => Deferred.done(owner.result, exit)),
        Effect.ignore,
      ),
    );
    return owner;
  }
  #borrowCamera(owner: CameraOwner): Effect.Effect<CameraPreview, unknown> {
    owner.references++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owner.references--;
      const current = this.#camera;
      if (owner.references === 0 && "owner" in current && current.owner === owner && (current.status !== "live" || current.publication === null)) this.#transitionCamera({ status: "ended" });
    };
    return Deferred.await(owner.result).pipe(
      Effect.flatMap((track) => (track.readyState === "live" ? Effect.succeed({ track, release }) : Effect.fail(cancelledCaptureError()))),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) release();
        }),
      ),
    );
  }
  #useCamera<A>(use: (track: MediaStreamTrack) => Effect.Effect<A, unknown>, acquire?: (signal: AbortSignal) => Effect.Effect<MediaStreamTrack, unknown>): Effect.Effect<A, unknown> {
    return Effect.suspend(() => {
      let preview: CameraPreview | undefined;
      return this.#cameraSource("publication", acquire).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            preview = value;
          }),
        ),
        Effect.flatMap((value) => use(value.track)),
        Effect.ensuring(Effect.sync(() => preview?.release())),
      );
    });
  }
  #captureForPublish(source: "microphone" | "camera", media: ConnectionPorts["media"], prepare: (track: MediaStreamTrack) => Effect.Effect<void, unknown>): Effect.Effect<void, unknown> {
    return source === "camera" ? foreign(() => media.clearPreparedLocalTrack("camera", { stopTrack: false })).pipe(Effect.retry({ times: 1 }), Effect.andThen(this.#useCamera(prepare))) : this.#captureSource(source).pipe(Effect.flatMap(prepare));
  }
  #captureStream<A>(operation: () => Promise<MediaStream>, use: (stream: MediaStream) => Effect.Effect<A, unknown>, onCaptureError: (cause: unknown) => unknown = (cause) => cause, signal?: AbortSignal): Effect.Effect<A, unknown> {
    return Effect.suspend(() => {
      let cancelled = false;
      let captured: MediaStream | null = null;
      const cancel = () => {
        cancelled = true;
        stopStream(captured);
      };
      this.#pendingCaptures.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      return foreign(async () => {
        if (cancelled) throw cancelledCaptureError();
        const stream = await operation();
        captured = stream;
        // Browser capture cannot be aborted; this owner must dispose its late result.
        if (cancelled || this.#ports?.media.getSnapshot().connection.phase === "stopped") {
          stopStream(stream);
          throw cancelledCaptureError();
        }
        return stream;
      }).pipe(
        Effect.mapError(onCaptureError),
        Effect.flatMap(use),
        Effect.tap(() => (cancelled ? Effect.fail(cancelledCaptureError()) : Effect.void)),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            this.#pendingCaptures.delete(cancel);
            signal?.removeEventListener("abort", cancel);
            if (Exit.isFailure(exit)) cancel();
          }),
        ),
      );
    });
  }
  #cancelCaptures(): void {
    this.#transitionCamera({ status: "ended" });
    for (const cancel of this.#pendingCaptures) cancel();
    this.#pendingCaptures.clear();
  }
  #captureSource(source: "microphone" | "camera", signal?: AbortSignal): Effect.Effect<MediaStreamTrack, unknown> {
    return this.#captureStream(
      () => this.#selection.getUserMedia({ audio: source === "microphone", video: source === "camera" }),
      (stream) =>
        this.#refreshDevices().pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.try({
              try: () => {
                const track = stream.getTracks().find((candidate) => candidate.kind === (source === "microphone" ? "audio" : "video"));
                if (!track) throw new TypeError(`Media capture did not return a ${source} track`);
                for (const candidate of stream.getTracks()) if (candidate !== track) candidate.stop();
                return track;
              },
              catch: (cause) => cause,
            }),
          ),
        ),
      (cause) => captureError(cause, source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled", `${source} permission was denied`),
      signal,
    );
  }
  #refreshDevices(): Effect.Effect<void, unknown> {
    return foreign(() => this.#selection.enumerateDevices()).pipe(
      Effect.tap((devices) =>
        Effect.sync(() => {
          const current = this.#store.getSnapshot().media;
          const next = Object.freeze({ microphones: mediaDevicesOfKind(devices, "audioinput"), cameras: mediaDevicesOfKind(devices, "videoinput"), speakers: mediaDevicesOfKind(devices, "audiooutput") });
          if (!sameDevices(current.devices, next)) this.#store.updateMedia(Object.freeze({ ...current, devices: next }));
        }),
      ),
      Effect.asVoid,
    );
  }
  #discardCaptured(source: MediaSource, track: MediaStreamTrack, media: ConnectionPorts["media"], prepared: boolean): Effect.Effect<void, unknown> {
    if (source === "camera")
      return Effect.sync(() => {
        if (this.#track(source) === track) this.#deleteTrack(source);
      });
    const clear = prepared ? foreign(() => media.clearPreparedLocalTrack(source)).pipe(Effect.ignore) : Effect.void;
    return clear.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (this.#track(source) === track) this.#deleteTrack(source);
          track.stop();
        }),
      ),
    );
  }
  #rollbackCapture(input: CaptureRollback): Effect.Effect<void, unknown> {
    if (isAccessInvalid(input.cause)) return Effect.fail(input.cause);
    const rollback = input.track ? this.#discardCaptured(input.source, input.track, input.media, input.prepared) : input.fallback;
    const captureWasUnavailable = input.action === "startScreenShare" && !input.prepared && input.track === null;
    const failure = isPermissionDenied(input.cause) || captureWasUnavailable ? captureError(input.cause, input.action, input.permissionMessage) : input.cause;
    return rollback.pipe(Effect.andThen(Effect.sync(() => this.#publish())), Effect.andThen(Effect.fail(failure)));
  }
  #canUsePorts(ports: ConnectionPorts): boolean {
    return this.#ports?.sync === ports.sync && this.#ports.media === ports.media && ports.media.getSnapshot().connection.phase !== "stopped";
  }
  #assertActivePorts(ports: ConnectionPorts, action: "setMicrophoneEnabled" | "setCameraEnabled" | "startScreenShare" | "stopScreenShare"): void {
    if (this.#connection.getSnapshot().state === "live" && this.#canUsePorts(ports)) return;
    throw new ConnectionError({ code: "invalid_state", action, recoverable: false, message: `${action} belongs to an inactive connection` });
  }
  #pausePublication(ports: ConnectionPorts, source: MediaSource, revision: number): void {
    const state = this.#sources[source];
    if (state.desired.revision !== revision || state.forcedRevision === revision || ports.sync.getSnapshot().control?.status === "ended") return;
    state.forcedRevision = revision;
    state.localEnabled = false;
    this.#pauseTracks(source);
    ports.media.setLocalSourceIntent?.(source, false);
    if (ports.media.closeForcedLocalPublication)
      this.#retainPause(
        state,
        Promise.resolve().then(() => ports.media.closeForcedLocalPublication!(source)),
      );
    this.#publish();
  }
  #bind(ports: ConnectionPorts | null): void {
    if (ports && this.#ports?.sync === ports.sync && this.#ports.media === ports.media) return;
    this.#rememberRecoveryIntents();
    for (const unsubscribe of [this.#unsubscribeMedia, this.#unsubscribeRequests, this.#unsubscribePause, this.#unsubscribeSync]) unsubscribe?.();
    this.#unsubscribeMedia = null;
    this.#unsubscribeRequests = null;
    this.#unsubscribePause = null;
    this.#unsubscribeSync = null;
    this.#ports = ports;
    this.#projection.reset();
    this.#syncLive = false;
    this.#bindCamera(ports);
    if (!ports) {
      this.#resetObservations();
      this.#cancelCaptures();
      this.#screenAudioTrack?.stop();
      this.#screenAudioTrack = null;
      for (const track of this.#tracks.values()) track.stop();
      this.#clearTracks();
      this.#clearRequests();
      this.#publish();
      return;
    }
    this.#unsubscribeMedia = ports.media.subscribe(() => {
      this.#applyRemoteMediaState(ports, ports.sync.getSnapshot());
      this.#publish();
    });
    this.#unsubscribePause = this.#subscribePauses(ports);
    this.#unsubscribeRequests = ports.sync.onDirectedRequest((request) => this.#request(request));
    this.#unsubscribeSync = this.#subscribeSync(ports);
    this.#applyRemoteMediaState(ports, ports.sync.getSnapshot());
    this.#publish();
  }
  #subscribePauses(ports: ConnectionPorts): (() => void) | null {
    return (
      ports.sync.onMediaPause?.((pause) => {
        const state = this.#sources[pause.source];
        if (pause.revision <= state.serverSequence) return;
        state.serverSequence = pause.revision;
        // Revision evidence orders moderation against user consent, including unsent capture.
        if (pause.revision > state.desired.controlRevision) this.#pausePublication(ports, pause.source, state.desired.revision);
      }) ?? null
    );
  }
  #rememberRecoveryIntents(): void {
    if (!this.#ports) return;
    // Consent belongs to the user action, not a disposable Sync subscription or
    // a projection that may never have confirmed the publication before loss.
    this.#recovering ??= new Map(MEDIA_SOURCES.filter((source) => this.#sources[source].desired.enabled).map((source) => [source, this.#sources[source].desired.revision]));
  }
  #pauseRecoveredIntents(ports: ConnectionPorts, snapshot: SyncSnapshot): void {
    const recovering = this.#recovering;
    this.#recovering = null;
    for (const [source, revision] of recovering ?? []) {
      const current = snapshot.media?.items.find((item) => item.participantId === snapshot.participantId && item.source === source);
      if (!current?.enabled) this.#pausePublication(ports, source, revision);
    }
  }
  #subscribeSync(ports: ConnectionPorts): () => void {
    return ports.sync.subscribe((snapshot) => {
      this.#removeRequestsFromMissingParticipants(snapshot);
      this.#applyRemoteMediaState(ports, snapshot);
      this.#reconcileIntents();
      this.#publish();
    });
  }
  #bindCamera(ports: ConnectionPorts | null): void {
    if (!ports) return;
    const state = this.#camera;
    if (state.status === "live" && state.publication === "initial") this.#transitionCamera({ ...state, publication: ports.media });
  }
  #applyRemoteMediaState(ports: ConnectionPorts, snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>): void {
    for (const publication of ports.media.getSnapshot().remoteTracks) {
      publication.track.enabled = snapshot.media?.items.some((item) => item.participantId === publication.participantId && item.source === (publication.source === "screen_audio" ? "screen" : publication.source) && item.enabled) ?? false;
    }
  }
  #request(request: V1DirectedRequest): void {
    if (request.expires_at_ms <= this.#now()) return;
    const control = this.#ports?.sync.getSnapshot().optimisticControl ?? this.#ports?.sync.getSnapshot().control;
    const incoming: IncomingMediaRequest = Object.freeze({
      requestId: request.request_id,
      kind: request.name === "request_unmute" ? "unmute" : "start_camera",
      actorParticipantId: request.actor_participant_id,
      actorDisplayName: control?.participants.find((participant) => participant.participantId === request.actor_participant_id)?.displayName ?? null,
      expiresAt: new Date(request.expires_at_ms).toISOString(),
    });
    const retained = this.#requests.filter((candidate) => candidate.requestId !== incoming.requestId && !(candidate.actorParticipantId === incoming.actorParticipantId && candidate.kind === incoming.kind));
    for (const candidate of this.#requests) if (!retained.includes(candidate)) this.#requestGenerations.delete(candidate.requestId);
    this.#requests = Object.freeze([...retained, incoming]);
    const generation = (this.#requestGenerations.get(incoming.requestId) ?? 0) + 1;
    this.#requestGenerations.set(incoming.requestId, generation);
    this.#fork(
      Effect.sleep(Math.max(0, request.expires_at_ms - this.#now())).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.#requestGenerations.get(incoming.requestId) === generation) this.#removeRequest(incoming.requestId);
          }),
        ),
      ),
    );
    this.#publish();
  }
  #removeRequestsFromMissingParticipants(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>): void {
    const participants = snapshot.optimisticControl?.participants ?? snapshot.control?.participants ?? [];
    const ids = new Set(participants.map((participant) => participant.participantId));
    for (const request of this.#requests) if (!ids.has(request.actorParticipantId)) this.#removeRequest(request.requestId);
  }
  #removeRequest(requestId: string): void {
    const requests = this.#requests.filter((request) => request.requestId !== requestId);
    if (requests.length === this.#requests.length) return;
    this.#requests = Object.freeze(requests);
    this.#requestGenerations.delete(requestId);
    this.#publish();
  }
  #clearRequests(): void {
    this.#requestGenerations.clear();
    this.#requests = Object.freeze([]);
  }
  #handleConnectionChange(): void {
    this.#reconcileIntents();
    this.#publish();
  }
  #handleScreenAudioEnded(track: MediaStreamTrack, ports: ConnectionPorts): void {
    this.#fork(
      this.#serialize(
        "screen",
        Effect.suspend(() => {
          if (this.#screenAudioTrack !== track || this.#ports !== ports) return Effect.void;
          return this.#clearScreenAudio(ports.media).pipe(Effect.ensuring(Effect.sync(() => this.#publish())));
        }),
      ).pipe(Effect.ignore),
    );
  }
  #handleScreenEnded(track = this.#track("screen")): void {
    if (!track || this.#track("screen") !== track) return;
    // The browser Stop sharing button is a user action, just like our Stop control.
    this.#fork(this.#stopScreen().pipe(Effect.ignore));
  }
  #observeProjections(): void {
    const ports = this.#ports;
    this.#watchMicrophone(ports?.media.getSnapshot().localTracks.find((item) => item.source === "microphone")?.track ?? this.#track("microphone") ?? null);
    if (!ports) {
      this.#projection.reset();
      return;
    }
    this.#enforcePause(ports, "microphone");
    this.#enforcePause(ports, "camera");
    if (!this.#syncLive) {
      this.#projection.reset();
      return;
    }
    this.#observeProjection(ports, "microphone");
    this.#observeProjection(ports, "camera");
  }
  #enforcePause(ports: ConnectionPorts, source: "microphone" | "camera"): void {
    const publication = ports.media.getSnapshot().localTracks.find((item) => item.source === source);
    if (!this.#hasConsent(source) && livePublication(publication)) {
      this.#pauseTracks(source);
      ports.media.setLocalSourceIntent?.(source, false);
    }
  }
  #observeProjection(ports: ConnectionPorts, source: "microphone" | "camera"): void {
    const sync = ports.sync.getSnapshot();
    const state = this.#sources[source];
    const publication = ports.media.getSnapshot().localTracks.find((item) => item.source === source);
    const projection = sync.media?.items.find((item) => item.participantId === sync.participantId && item.source === source) ?? { enabled: false, publicationId: null };
    this.#projection.observe(source, {
      revision: state.desired.revision,
      publicationId: publication?.publicationId ?? null,
      enabled: livePublication(publication),
      projectedEnabled: projection.enabled,
      projectedPublicationId: projection.publicationId,
    });
  }
  #confirmedLocal(source: "microphone" | "camera"): MediaSlice["local"][MediaSource] {
    const publication = this.#ports?.media.getSnapshot().localTracks.find((item) => item.source === source);
    const sync = this.#ports?.sync.getSnapshot();
    const projected = sync?.media?.items.some((item) => item.participantId === sync.participantId && item.source === source && item.enabled && item.publicationId === publication?.publicationId) ?? false;
    const confirmed = this.#syncLive && livePublication(publication) && projected;
    const pending = this.#pendingSources.has(source) || this.#connection.getSnapshot().state === "joining";
    const media = { source, track: publication?.track ?? this.#track(source) ?? null, state: "disabled" } satisfies MediaSlice["local"][MediaSource];
    return confirmedLocalMedia(media, this.#hasConsent(source), pending, confirmed, this.#syncLive, this.#projection.state(source));
  }
  #publish(): void {
    const current = this.#store.getSnapshot();
    const snapshot = this.#ports?.media.getSnapshot();
    const state = this.#connection.getSnapshot().state;
    this.#observeProjections();
    const local = Object.freeze({
      microphone: this.#confirmedLocal("microphone"),
      camera: this.#confirmedLocal("camera"),
      screen: localMedia("screen", this.#localTracks(), snapshot, false, state, this.#pendingSources.has("screen") && this.#sources.screen.desired.enabled),
    });
    const remote = Object.freeze((snapshot?.remoteTracks ?? []).map((track) => Object.freeze({ participantId: track.participantId, source: track.source, publicationId: track.publicationId, track: track.track })));
    const media = Object.freeze({
      ...current.media,
      local,
      remote,
      screenShare: {
        ...local.screen,
        hasAudio: Boolean(this.#screenAudioTrack?.readyState === "live" && snapshot?.localTracks.some((track) => track.source === "screen_audio" && track.enabled && track.track.readyState === "live")),
        ...(local.screen.track ? { capture: screenShareCapture(local.screen.track) } : {}),
      },
      incomingRequests: this.#requests,
    });
    if (!sameMediaSlice(current.media, media)) this.#store.updateMedia(media);
  }
}
function liveTrack(track: MediaStreamTrack): boolean {
  return track.enabled && track.readyState === "live" && !track.muted;
}
function livePublication(publication: ConnectionMediaSnapshot["localTracks"][number] | undefined): boolean {
  return !!publication?.enabled && liveTrack(publication.track);
}
function confirmedLocalMedia(media: MediaSlice["local"][MediaSource], desired: boolean, pending: boolean, confirmed: boolean, live: boolean, convergence: "requesting" | "failed" | null): MediaSlice["local"][MediaSource] {
  if (!desired) return { ...media, state: convergence === "failed" ? "failed" : "disabled" };
  if (convergence) return { ...media, state: convergence };
  if (!live && media.track && liveTrack(media.track)) return { ...media, state: "requesting" };
  return { ...media, state: confirmed ? "enabled" : pending ? "requesting" : "disabled" };
}
function cancelledCaptureError(): ConnectionError {
  return new ConnectionError({ code: "invalid_state", action: null, recoverable: false, message: "Media capture was cancelled before its result could be used" });
}
function foreign<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}
function selectInitialTracks(stream: MediaStream, intent: Readonly<Record<"microphone" | "camera", boolean>>): Map<"microphone" | "camera", MediaStreamTrack> {
  const tracks = stream.getTracks();
  const microphone = initialTrackFor(tracks, intent.microphone, "audio");
  const camera = initialTrackFor(tracks, intent.camera, "video");
  const selected = new Set(initialTracks(microphone, camera));
  for (const track of tracks) if (!selected.has(track)) track.stop();
  if (missingInitialTrack(intent, microphone, camera)) {
    for (const track of selected) track.stop();
    throw new TypeError("Media capture did not return every requested track");
  }
  return new Map(initialTrackEntries(microphone, camera));
}
function initialTrackFor(tracks: readonly MediaStreamTrack[], enabled: boolean, kind: MediaStreamTrack["kind"]): MediaStreamTrack | undefined {
  if (!enabled) return undefined;
  return tracks.find((track) => track.kind === kind);
}
function initialTracks(microphone: MediaStreamTrack | undefined, camera: MediaStreamTrack | undefined): readonly MediaStreamTrack[] {
  return [microphone, camera].filter((track): track is MediaStreamTrack => track !== undefined);
}
function missingInitialTrack(intent: Readonly<Record<"microphone" | "camera", boolean>>, microphone: MediaStreamTrack | undefined, camera: MediaStreamTrack | undefined): boolean {
  return (intent.microphone && !microphone) || (intent.camera && !camera);
}
function initialTrackEntries(microphone: MediaStreamTrack | undefined, camera: MediaStreamTrack | undefined): readonly (readonly ["microphone" | "camera", MediaStreamTrack])[] {
  const entries: ["microphone" | "camera", MediaStreamTrack][] = [];
  if (microphone) entries.push(["microphone", microphone]);
  if (camera) entries.push(["camera", camera]);
  return entries;
}
function localMedia(source: MediaSource, tracks: ReadonlyMap<MediaSource, MediaStreamTrack>, snapshot: ConnectionMediaSnapshot | undefined, intended: boolean, connectionState: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>["state"], pending: boolean) {
  if (snapshot?.connection.phase === "stopped") return Object.freeze({ source, state: "unavailable" as const, track: null });
  const track = tracks.get(source) ?? null;
  const publication = snapshot?.localTracks.find((candidate) => candidate.source === source);
  if (pending) return Object.freeze({ source, state: "requesting" as const, track });
  if (locallyMuted(intended, track, publication)) return Object.freeze({ source, state: "disabled" as const, track });
  if (publication?.enabled) return Object.freeze({ source, state: "enabled" as const, track });
  if (publication && connectionState === "live") return Object.freeze({ source, state: "disabled" as const, track });
  return Object.freeze({ source, state: localMediaState(source, track, intended, connectionState), track });
}
function locallyMuted(intended: boolean, track: MediaStreamTrack | null, publication: ConnectionMediaSnapshot["localTracks"][number] | undefined): boolean {
  return !intended && track?.enabled === false && publication?.enabled === false;
}
function localMediaState(source: MediaSource, track: MediaStreamTrack | null, intended: boolean, connectionState: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>["state"]): MediaSlice["local"][MediaSource]["state"] {
  if (!mediaIsDesired(source, track, intended)) return inactiveLocalMediaState(connectionState, track);
  if (connectionState === "joining" || track) return "requesting";
  return activeLocalMediaState(connectionState);
}
function mediaIsDesired(source: MediaSource, track: MediaStreamTrack | null, intended: boolean): boolean {
  return source === "screen" ? track !== null : intended;
}
function inactiveLocalMediaState(connectionState: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>["state"], track: MediaStreamTrack | null): MediaSlice["local"][MediaSource]["state"] {
  return connectionState === "live" || connectionState === "reconnecting" || track ? "disabled" : "unavailable";
}
function activeLocalMediaState(connectionState: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>["state"]): MediaSlice["local"][MediaSource]["state"] {
  return connectionState === "failed" || connectionState === "live" || connectionState === "reconnecting" ? "failed" : "unavailable";
}
function sameMediaSlice(left: MediaSlice, right: MediaSlice): boolean {
  if (left.selection !== right.selection || !sameDevices(left.devices, right.devices)) return false;
  for (const source of MEDIA_SOURCES) if (!sameLocalMedia(left.local[source], right.local[source])) return false;
  return sameScreenShare(left.screenShare, right.screenShare) && sameRemoteMedia(left.remote, right.remote) && sameRequests(left.incomingRequests, right.incomingRequests);
}
function sameScreenShare(left: MediaSlice["screenShare"], right: MediaSlice["screenShare"]): boolean {
  return sameLocalMedia(left, right) && left.hasAudio === right.hasAudio && left.capture?.surface === right.capture?.surface && left.capture?.label === right.capture?.label;
}
function sameLocalMedia(left: MediaSlice["local"][MediaSource], right: MediaSlice["local"][MediaSource]): boolean {
  return left.source === right.source && left.state === right.state && left.track === right.track;
}
function sameRemoteMedia(left: MediaSlice["remote"], right: MediaSlice["remote"]): boolean {
  return left.length === right.length && left.every((track, index) => track.participantId === right[index]?.participantId && track.source === right[index]?.source && track.publicationId === right[index]?.publicationId && track.track === right[index]?.track);
}
function sameRequests(left: MediaSlice["incomingRequests"], right: MediaSlice["incomingRequests"]): boolean {
  return left.length === right.length && left.every((request, index) => sameRequest(request, right[index]));
}
function sameRequest(left: IncomingMediaRequest, right: IncomingMediaRequest | undefined): boolean {
  if (!right) return false;
  return left.requestId === right.requestId && left.kind === right.kind && left.actorParticipantId === right.actorParticipantId && left.actorDisplayName === right.actorDisplayName && left.expiresAt === right.expiresAt;
}
function mediaDevicesOfKind(devices: readonly MediaDeviceInfo[], kind: MediaDeviceKind): MediaSlice["devices"]["microphones"] {
  return Object.freeze(devices.filter((device) => device.kind === kind).map((device) => Object.freeze({ deviceId: device.deviceId, label: device.label })));
}
function sameDevices(left: MediaSlice["devices"], right: MediaSlice["devices"]): boolean {
  return sameDeviceList(left.microphones, right.microphones) && sameDeviceList(left.cameras, right.cameras) && sameDeviceList(left.speakers, right.speakers);
}
function sameDeviceList(left: MediaSlice["devices"]["microphones"], right: MediaSlice["devices"]["microphones"]): boolean {
  return left.length === right.length && left.every((device, index) => device.deviceId === right[index]?.deviceId && device.label === right[index]?.label);
}
function captureError(cause: unknown, action: "join" | "setMicrophoneEnabled" | "setCameraEnabled" | "startScreenShare", permissionMessage: string): ConnectionError {
  if (cause instanceof ConnectionError) return cause;
  if (isPermissionDenied(cause)) return new ConnectionError({ code: "permission_denied", action, recoverable: true, message: permissionMessage }, { cause });
  const failure = describeMediaCaptureError(cause);
  return new ConnectionError({ ...failure, action, message: action === "startScreenShare" ? "Screen sharing could not start. Check screen recording permission and try again in a supported browser or app." : failure.message }, { cause });
}
function isPermissionDenied(cause: unknown): boolean {
  return describeMediaCaptureError(cause).code === "permission_denied";
}
function isAccessInvalid(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    ((
      cause as {
        readonly code?: unknown;
      }
    ).code === "access.invalid" ||
      (
        cause as {
          readonly code?: unknown;
        }
      ).code === "invalid_access")
  );
}
