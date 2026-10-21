import { Clock, Context, Deferred, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import type { ConnectionMediaSnapshot, MediaSource } from "../media";
import { describeMediaCaptureError } from "../media/capture-error";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { displayMediaConstraints, screenShareCapture, requireDisplayVideoTrack, stopStream, streamFromTracks } from "../connection/media-devices";
import { ConnectionError } from "../connection/types";
import type { V1DirectedRequest } from "../sync";
import { V1SyncError } from "../sync/v1-error";
import { normalizeClientError, SpaceClientError } from "./errors";
import type { MediaDeviceSelection } from "./media-device-selection";
import { SpaceStore } from "./store";
import type { IncomingMediaRequest, CameraPreview, MediaSlice, ScreenShareOptions } from "./types";
const MEDIA_SOURCES = ["microphone", "camera", "screen"] as const;
type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;
type Fork = (effect: Effect.Effect<void, unknown, Clock.Clock>) => void;
type CaptureAction = "join" | "setMicrophoneEnabled" | "setCameraEnabled" | "startScreenShare";
type CaptureRollback = {
  readonly action: CaptureAction;
  readonly cause: unknown;
  readonly fallback: Effect.Effect<void, unknown>;
  readonly media: ConnectionPorts["media"];
  readonly permissionMessage: string;
  readonly prepared: boolean;
  readonly restoreIntent?: () => void;
  readonly source: MediaSource;
  readonly track: MediaStreamTrack | null;
};
type CameraOwner = {
  readonly result: Deferred.Deferred<MediaStreamTrack, unknown>;
  readonly cancel: () => void;
  references: number;
};
type CameraState = { readonly status: "idle" | "ended" } | { readonly status: "capturing"; readonly owner: CameraOwner } | { readonly status: "live"; readonly owner: CameraOwner; readonly track: MediaStreamTrack; readonly published: boolean; readonly onEnded: () => void };
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
  readonly #observedPublicationIds = new Map<MediaSource, string>();
  readonly #intentRevisions = new Map<MediaSource, number>();
  readonly #pendingEnables = new Map<MediaSource, number>();
  readonly #pendingSources = new Set<MediaSource>();
  readonly #pendingCaptures = new Set<() => void>();
  readonly #requestGenerations = new Map<string, number>();
  #camera: CameraState = { status: "idle" };
  #intent = { microphone: true, camera: true };
  #requests: readonly IncomingMediaRequest[] = Object.freeze([]);
  #ports: ConnectionPorts | null = null;
  #screenEndedPending = false;
  #screenAudioTrack: MediaStreamTrack | null = null;
  #unsubscribeMedia: (() => void) | null = null;
  #unsubscribeRequests: (() => void) | null = null;
  #unsubscribeSync: (() => void) | null = null;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeScreenEnded: (() => void) | null = null;
  #unsubscribePorts: (() => void) | null = null;
  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, selection: MediaDeviceSelection, gates: ReadonlyMap<MediaSource, Semaphore.Semaphore>, now: () => number, fork: Fork) {
    this.#connection = connection;
    this.#store = store;
    this.#selection = selection;
    this.#gates = gates;
    this.#now = now;
    this.#fork = fork;
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
    if (intent.microphone !== undefined) this.#intent.microphone = intent.microphone;
    if (intent.camera !== undefined) this.#intent.camera = intent.camera;
  }
  setMicrophoneEnabled = (enabled: boolean): ClientEffect<void> => this.#set("microphone", enabled);
  setCameraEnabled = (enabled: boolean): ClientEffect<void> => this.#set("camera", enabled);
  captureCameraPreview = (): ClientEffect<CameraPreview> => this.#cameraSource("preview").pipe(Effect.mapError(normalizeClientError));
  setScreenShareEnabled = (enabled: boolean, options?: ScreenShareOptions): ClientEffect<void> => (enabled ? this.#startScreen(options) : this.#stopScreen());
  selectMicrophone = (deviceId: string): ClientEffect<void> =>
    Effect.sync(() => {
      this.#selection.selectCapture("microphone", deviceId);
      this.#store.select("microphone", deviceId);
    }).pipe(Effect.mapError(normalizeClientError));
  selectCamera = (deviceId: string): ClientEffect<void> =>
    Effect.sync(() => {
      this.#selection.selectCapture("camera", deviceId);
      if (!this.#intent.camera) {
        this.#transitionCamera({ status: "ended" });
      }
      this.#store.select("camera", deviceId);
    }).pipe(Effect.mapError(normalizeClientError));
  selectSpeaker = (deviceId: string): ClientEffect<void> =>
    foreign(() => this.#selection.selectSpeaker(deviceId)).pipe(
      Effect.tap(() => Effect.sync(() => this.#store.select("speaker", deviceId))),
      Effect.mapError(normalizeClientError),
    );
  acceptRequest = (requestId: string): ClientEffect<void> => {
    return Effect.suspend(() => {
      const request = this.#requests.find((candidate) => candidate.requestId === requestId);
      if (!request) return Effect.fail(new SpaceClientError({ code: "media.request_invalid", recoverable: false, message: "The media request is no longer active" }));
      return (request.kind === "unmute" ? this.#set("microphone", true) : this.#set("camera", true)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.#removeRequest(requestId);
          }),
        ),
      );
    }).pipe(Effect.mapError(normalizeClientError));
  };
  declineRequest = (requestId: string): ClientEffect<void> => {
    return Effect.sync(() => {
      this.#removeRequest(requestId);
    }).pipe(Effect.mapError(normalizeClientError));
  };
  initialIntent(): Readonly<{
    microphone: boolean;
    camera: boolean;
  }> {
    return { ...this.#intent };
  }
  captureInitial(intent: Readonly<{ microphone: boolean; camera: boolean }>): Effect.Effect<MediaStream, unknown> {
    if (!intent.camera) return this.#captureInitial(intent);
    return this.#useCamera(
      (track) =>
        Effect.sync(() => this.#setTrack("camera", track)).pipe(
          Effect.andThen(Effect.suspend(() => (intent.microphone && !this.#hasTrack("microphone") ? this.#captureSource("microphone").pipe(Effect.tap((audio) => Effect.sync(() => this.#setTrack("microphone", audio)))) : Effect.void))),
          Effect.map(() => {
            this.#intent = { microphone: this.#hasTrack("microphone"), camera: true };
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
      this.#intent = { microphone: this.#hasTrack("microphone"), camera: this.#hasTrack("camera") };
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
              this.#intent = { microphone: this.#hasTrack("microphone"), camera: this.#hasTrack("camera") };
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
    this.#cancelCaptures();
    this.#unsubscribeMedia?.();
    this.#unsubscribeRequests?.();
    this.#unsubscribeSync?.();
    this.#unsubscribeConnection?.();
    this.#unsubscribeScreenEnded?.();
    this.#unsubscribePorts?.();
    this.#unsubscribeMedia = null;
    this.#unsubscribeRequests = null;
    this.#unsubscribeSync = null;
    this.#unsubscribeConnection = null;
    this.#unsubscribeScreenEnded = null;
    this.#unsubscribePorts = null;
    this.#ports = null;
    this.#screenAudioTrack?.stop();
    this.#screenAudioTrack = null;
    for (const track of this.#tracks.values()) track.stop();
    this.#clearTracks();
    this.#clearRequests();
    this.#publish();
  }
  #set(source: "microphone" | "camera", enabled: boolean): ClientEffect<void> {
    let previousIntent = this.#intent[source];
    let intentRevision = 0;
    let earlyPause: Promise<void> | null = null;
    const localPause = Effect.suspend(() => {
      previousIntent = this.#intent[source];
      intentRevision = (this.#intentRevisions.get(source) ?? 0) + 1;
      this.#intentRevisions.set(source, intentRevision);
      this.#intent[source] = enabled;
      if (enabled) this.#pendingEnables.set(source, intentRevision);
      this.#ports?.media.setLocalSourceIntent?.(source, enabled);
      if (!enabled && this.#ports) earlyPause = this.#beginLocalPause(this.#ports, source);
      return Effect.void;
    });
    return localPause
      .pipe(
        Effect.andThen(
          this.#serialize(
            source,
            this.#connection.runCommand((ports) => {
              let captured: MediaStreamTrack | null = null;
              let prepared = false;
              const action = source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled";
              return Effect.suspend(() => {
                if (!enabled) {
                  let paused = false;
                  return (earlyPause ? foreign(() => earlyPause!) : this.#localTarget(ports, source, false)).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        paused = true;
                      }),
                    ),

                    Effect.andThen(source === "microphone" ? foreign(() => ports.sync.setMicrophoneEnabled(false)) : foreign(() => ports.sync.setCameraEnabled(false))),

                    Effect.asVoid,
                    Effect.catch((cause) => {
                      if ((paused && !isSyncRejection(cause)) || this.#intentRevisions.get(source) !== intentRevision) return Effect.fail(cause);
                      this.#intent[source] = previousIntent;
                      ports.media.setLocalSourceIntent?.(source, previousIntent);
                      return this.#localTarget(ports, source, previousIntent).pipe(
                        Effect.catch(() => Effect.void),
                        Effect.andThen(Effect.fail(cause)),
                      );
                    }),
                  );
                }
                const acquire =
                  enabled && !this.#hasTrack(source)
                    ? this.#captureForPublish(source, (track) =>
                        Effect.sync(() => {
                          captured = track;
                          try {
                            this.#assertActivePorts(ports, action);
                          } catch (cause) {
                            if (source !== "camera") track.stop();
                            throw cause;
                          }
                          this.#setTrack(source, track);
                          ports.media.prepareLocalTrack(source, track);
                          prepared = true;
                          this.#publish();
                        }),
                      )
                    : Effect.void;
                return acquire.pipe(
                  Effect.asVoid,

                  Effect.andThen(source === "microphone" ? foreign(() => ports.sync.setMicrophoneEnabled(enabled)) : foreign(() => ports.sync.setCameraEnabled(enabled))),

                  Effect.tap(() => Effect.sync(() => this.#assertActivePorts(ports, action))),

                  Effect.asVoid,
                  Effect.catch((cause) =>
                    this.#rollbackCapture({
                      action,
                      cause,
                      fallback: Effect.void,
                      media: ports.media,
                      permissionMessage: `${source} permission was denied`,
                      prepared,
                      restoreIntent: () => {
                        if (this.#intentRevisions.get(source) === intentRevision) this.#intent[source] = previousIntent;
                      },
                      source,
                      track: captured,
                    }),
                  ),
                );
              });
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError(normalizeClientError),

        Effect.ensuring(
          Effect.sync(() => {
            if (this.#pendingEnables.get(source) === intentRevision) this.#pendingEnables.delete(source);
          }),
        ),
      );
  }
  #startScreen(options?: ScreenShareOptions): ClientEffect<void> {
    let intentRevision = 0;
    return Effect.sync(() => {
      intentRevision = (this.#intentRevisions.get("screen") ?? 0) + 1;
      this.#intentRevisions.set("screen", intentRevision);
      this.#pendingEnables.set("screen", intentRevision);
      this.#ports?.media.setLocalSourceIntent?.("screen", true);
    })
      .pipe(
        Effect.andThen(
          this.#serialize(
            "screen",
            this.#connection.runCommand((ports) => {
              let track: MediaStreamTrack | null = null;
              let prepared = false;
              return Effect.suspend(() => {
                if (this.#hasTrack("screen") && options === undefined) {
                  return Effect.void;
                }
                return this.#captureStream(
                  () => this.#selection.getDisplayMedia(displayMediaConstraints(options)),
                  (stream) =>
                    Effect.sync(() => {
                      this.#assertActivePorts(ports, "startScreenShare");
                      track = requireDisplayVideoTrack(stream);
                      return { stream, track };
                    }).pipe(
                      Effect.tap(() => {
                        const previous = this.#track("screen");
                        if (!previous) return Effect.void;
                        return foreign(() => ports.sync.setScreenShareEnabled(false)).pipe(
                          Effect.andThen(this.#clearScreenAudio(ports.media)),
                          Effect.andThen(foreign(() => ports.media.clearPreparedLocalTrack("screen"))),
                          Effect.tap(() =>
                            Effect.sync(() => {
                              this.#assertActivePorts(ports, "startScreenShare");
                              this.#deleteTrack("screen");
                              previous.stop();
                            }),
                          ),
                        );
                      }),
                      Effect.tap(({ stream: captured, track: screenTrack }) =>
                        Effect.sync(() => {
                          const audio = captured.getAudioTracks()[0];
                          for (const extra of captured.getAudioTracks().slice(1)) extra.stop();
                          ports.media.prepareLocalTrack("screen", screenTrack);
                          prepared = true;
                          this.#setTrack("screen", screenTrack);
                          this.#screenAudioTrack = audio ?? null;
                          if (audio) {
                            ports.media.prepareLocalTrack("screen_audio", audio);
                            audio.addEventListener("ended", () => this.#handleScreenAudioEnded(audio, ports));
                          }
                          screenTrack.addEventListener("ended", () => this.#handleScreenEnded(screenTrack));
                          this.#screenEndedPending = false;
                          this.#publish();
                        }),
                      ),
                      Effect.andThen(foreign(() => ports.sync.setScreenShareEnabled(true))),

                      Effect.tap(() => Effect.sync(() => this.#assertActivePorts(ports, "startScreenShare"))),

                      Effect.asVoid,
                      Effect.catch((cause) =>
                        (prepared ? this.#clearScreenAudio(ports.media) : Effect.void).pipe(
                          Effect.ignore,
                          Effect.andThen(this.#rollbackCapture({ action: "startScreenShare", cause, fallback: Effect.sync(() => stopStream(stream)), media: ports.media, permissionMessage: "Screen sharing permission was denied", prepared, source: "screen", track })),
                        ),
                      ),
                    ),
                  (cause) => captureError(cause, "startScreenShare", "Screen sharing permission was denied"),
                );
              });
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError(normalizeClientError),

        Effect.ensuring(
          Effect.sync(() => {
            if (this.#pendingEnables.get("screen") === intentRevision) this.#pendingEnables.delete("screen");
          }),
        ),
      );
  }
  #stopScreen(): ClientEffect<void> {
    let intentRevision = 0;
    let earlyPause: Promise<void> | null = null;
    const localPause = Effect.suspend(() => {
      intentRevision = (this.#intentRevisions.get("screen") ?? 0) + 1;
      this.#intentRevisions.set("screen", intentRevision);
      this.#ports?.media.setLocalSourceIntent?.("screen", false);
      if (this.#ports) earlyPause = this.#beginLocalPause(this.#ports, "screen");
      return Effect.void;
    });
    return localPause
      .pipe(
        Effect.andThen(
          this.#serialize(
            "screen",
            this.#connection.runCommand((ports) =>
              Effect.suspend(() => {
                const track = this.#track("screen");
                let paused = false;
                return (earlyPause ? foreign(() => earlyPause!) : this.#localTarget(ports, "screen", false)).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      paused = true;
                    }),
                  ),
                  Effect.andThen(foreign(() => ports.sync.setScreenShareEnabled(false))),
                  Effect.tap(() => Effect.sync(() => this.#assertActivePorts(ports, "stopScreenShare"))),
                  Effect.andThen(this.#clearScreenAudio(ports.media)),
                  Effect.andThen(foreign(() => ports.media.clearPreparedLocalTrack("screen"))),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      this.#assertActivePorts(ports, "stopScreenShare");
                      if (this.#track("screen") === track) this.#deleteTrack("screen");
                      track?.stop();
                      this.#screenEndedPending = false;
                      this.#publish();
                    }),
                  ),
                  Effect.asVoid,
                  Effect.catch((cause) =>
                    (paused && !isSyncRejection(cause)) || this.#intentRevisions.get("screen") !== intentRevision
                      ? Effect.fail(cause)
                      : Effect.sync(() => ports.media.setLocalSourceIntent?.("screen", true)).pipe(
                          Effect.andThen(this.#localTarget(ports, "screen", true)),
                          Effect.catch(() => Effect.void),
                          Effect.andThen(Effect.fail(cause)),
                        ),
                  ),
                );
              }),
            ),
          ),
        ),
      )
      .pipe(Effect.mapError(normalizeClientError));
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
    return this.#gates.get(source)!.withPermit(
      Effect.sync(() => {
        this.#pendingSources.add(source);
        this.#publish();
      }).pipe(
        Effect.andThen(effect),
        Effect.ensuring(
          Effect.sync(() => {
            this.#pendingSources.delete(source);
            this.#publish();
          }),
        ),
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
  }
  #track(source: MediaSource): MediaStreamTrack | undefined {
    if (source !== "camera") return this.#tracks.get(source);
    return this.#camera.status === "live" && this.#camera.published ? this.#camera.track : undefined;
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
      return;
    }
    const state = this.#camera;
    if (!("owner" in state)) throw cancelledCaptureError();
    if (state.status === "live" && state.track !== track) throw cancelledCaptureError();
    const onEnded = () => {
      if (this.#camera.status === "live" && this.#camera.track === track) this.#transitionCamera({ status: "ended" });
    };
    this.#transitionCamera({ status: "live", owner: state.owner, track, published: true, onEnded });
  }
  #deleteTrack(source: MediaSource): void {
    if (source !== "camera") {
      this.#tracks.delete(source);
      return;
    }
    const state = this.#camera;
    if (state.status !== "live") return;
    this.#transitionCamera(state.owner.references > 0 && state.track.readyState === "live" ? { ...state, published: false } : { status: "ended" });
  }
  #clearTracks(): void {
    this.#tracks.clear();
    this.#transitionCamera({ status: "ended" });
  }
  #cameraSource(purpose: "preview" | "publication", acquire: (signal: AbortSignal) => Effect.Effect<MediaStreamTrack, unknown> = (signal) => this.#captureSource("camera", signal)): Effect.Effect<CameraPreview, unknown> {
    return Effect.suspend(() => {
      if (this.#camera.status === "live" && this.#camera.track.readyState !== "live") this.#transitionCamera({ status: "ended" });
      const current = this.#camera;
      if (current.status === "live" && current.published && !current.track.enabled && purpose === "preview") {
        const track = current.track.clone();
        track.enabled = true;
        const release = () => {
          this.#pendingCaptures.delete(release);
          track.stop();
        };
        this.#pendingCaptures.add(release);
        return Effect.succeed({ track, release });
      }
      if (this.#camera.status === "idle" || this.#camera.status === "ended") {
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
              Effect.sync(() => {
                const state = this.#camera;
                if (abort.signal.aborted || !("owner" in state) || state.owner !== owner) {
                  track.stop();
                  throw cancelledCaptureError();
                }
                const onEnded = () => {
                  if (this.#camera.status === "live" && this.#camera.owner === owner) this.#transitionCamera({ status: "ended" });
                };
                this.#transitionCamera({ status: "live", owner, track, published: state.status === "live" && state.published, onEnded });
                if (track.readyState !== "live") {
                  this.#transitionCamera({ status: "ended" });
                  throw cancelledCaptureError();
                }
              }),
            ),
            Effect.onExit((exit) => Deferred.done(owner.result, exit)),
            Effect.ignore,
          ),
        );
      }
      const state = this.#camera;
      if (!("owner" in state)) return Effect.fail(cancelledCaptureError());
      const owner = state.owner;
      owner.references++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        owner.references--;
        const current = this.#camera;
        if (owner.references === 0 && "owner" in current && current.owner === owner && (current.status !== "live" || !current.published)) this.#transitionCamera({ status: "ended" });
      };
      return Deferred.await(owner.result).pipe(
        Effect.map((track) => {
          if (track.readyState !== "live") throw cancelledCaptureError();
          return { track, release };
        }),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) release();
          }),
        ),
      );
    });
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
  #captureForPublish(source: "microphone" | "camera", prepare: (track: MediaStreamTrack) => Effect.Effect<void, unknown>): Effect.Effect<void, unknown> {
    return source === "camera" ? this.#useCamera(prepare) : this.#captureSource(source).pipe(Effect.flatMap(prepare));
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
        if (cancelled) {
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
    const clear = prepared ? foreign(() => media.clearPreparedLocalTrack(source)).pipe(Effect.ignore) : Effect.void;
    return clear.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (this.#track(source) === track) this.#deleteTrack(source);
          if (source !== "camera") track.stop();
        }),
      ),
    );
  }
  #rollbackCapture(input: CaptureRollback): Effect.Effect<void, unknown> {
    if (isAccessInvalid(input.cause)) return Effect.fail(input.cause);
    input.restoreIntent?.();
    const rollback = input.track ? this.#discardCaptured(input.source, input.track, input.media, input.prepared) : input.fallback;
    const captureWasUnavailable = input.action === "startScreenShare" && !input.prepared && input.track === null;
    const failure = isPermissionDenied(input.cause) || captureWasUnavailable ? captureError(input.cause, input.action, input.permissionMessage) : input.cause;
    return rollback.pipe(Effect.andThen(Effect.sync(() => this.#publish())), Effect.andThen(Effect.fail(failure)));
  }
  #assertActivePorts(ports: ConnectionPorts, action: "setMicrophoneEnabled" | "setCameraEnabled" | "startScreenShare" | "stopScreenShare"): void {
    if (this.#connection.getSnapshot().state === "live" && this.#ports?.sync === ports.sync && this.#ports.media === ports.media) return;
    throw new ConnectionError({ code: "invalid_state", action, recoverable: false, message: `${action} belongs to an inactive connection` });
  }
  #bind(ports: ConnectionPorts | null): void {
    this.#unsubscribeMedia?.();
    this.#unsubscribeRequests?.();
    this.#unsubscribeSync?.();
    this.#unsubscribeMedia = null;
    this.#unsubscribeRequests = null;
    this.#unsubscribeSync = null;
    if (this.#ports?.media !== ports?.media) this.#observedPublicationIds.clear();
    this.#ports = ports;
    if (!ports) {
      this.#cancelCaptures();
      this.#screenAudioTrack?.stop();
      this.#screenAudioTrack = null;
      for (const track of this.#tracks.values()) track.stop();
      this.#clearTracks();
      this.#screenEndedPending = false;
      this.#clearRequests();
      this.#publish();
      return;
    }
    this.#unsubscribeMedia = ports.media.subscribe(() => {
      this.#applyRemoteMediaState(ports, ports.sync.getSnapshot());
      this.#publish();
    });
    this.#unsubscribeRequests = ports.sync.onDirectedRequest((request) => this.#request(request));
    this.#unsubscribeSync = ports.sync.subscribe((snapshot) => {
      this.#removeRequestsFromMissingParticipants(snapshot);
      this.#applyRemoteMediaState(ports, snapshot);
      this.#applyForcedMediaState(ports, snapshot);
    });
    this.#applyRemoteMediaState(ports, ports.sync.getSnapshot());
    this.#applyForcedMediaState(ports, ports.sync.getSnapshot());
    this.#publish();
  }
  #applyRemoteMediaState(ports: ConnectionPorts, snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>): void {
    for (const publication of ports.media.getSnapshot().remoteTracks) {
      publication.track.enabled = snapshot.media?.items.some((item) => item.participantId === publication.participantId && item.source === (publication.source === "screen_audio" ? "screen" : publication.source) && item.enabled) ?? false;
    }
  }
  #applyForcedMediaState(ports: ConnectionPorts, snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>): void {
    if (!canApplyForcedMediaState(snapshot)) return;
    for (const source of MEDIA_SOURCES) {
      const projected = snapshot.media.items.find((item) => item.participantId === snapshot.participantId && item.source === source);
      if (projected?.publicationId) {
        this.#observedPublicationIds.set(source, projected.publicationId);
        continue;
      }
      const previousPublicationId = this.#observedPublicationIds.get(source);
      if (!this.#observedPublicationIds.delete(source)) continue;
      const local = ports.media.getSnapshot().localTracks.find((publication) => publication.source === source);
      if (local && local.publicationId !== previousPublicationId) continue;
      this.#pauseForcedSource(ports, source);
    }
  }
  #pauseForcedSource(ports: ConnectionPorts, source: MediaSource): void {
    const pendingEnable = this.#hasPendingEnable(source);
    if (!pendingEnable) {
      this.#clearForcedIntent(source);
    }
    const track = this.#track(source);
    if (track) track.enabled = false;
    ports.media.setLocalSourceIntent?.(source, false);
    if (ports.media.closeForcedLocalPublication) void ports.media.closeForcedLocalPublication(source).catch(() => undefined);
    if (pendingEnable) ports.media.setLocalSourceIntent?.(source, true);
    this.#publish();
  }
  #clearForcedIntent(source: MediaSource): void {
    this.#intentRevisions.set(source, (this.#intentRevisions.get(source) ?? 0) + 1);
    if (source !== "screen") this.#intent[source] = false;
    else if (this.#screenAudioTrack) this.#screenAudioTrack.enabled = false;
  }
  #hasPendingEnable(source: MediaSource): boolean {
    const revision = this.#pendingEnables.get(source);
    return revision !== undefined && revision === this.#intentRevisions.get(source);
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
    if (this.#screenEndedPending && this.#connection.getSnapshot().state === "live") {
      this.#screenEndedPending = false;
      this.#fork(this.#stopScreen().pipe(Effect.ignore));
    }
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
    if (this.#connection.getSnapshot().state === "reconnecting") {
      this.#screenEndedPending = true;
      return;
    }
    this.#fork(this.#stopScreen().pipe(Effect.ignore));
  }
  #publish(): void {
    const current = this.#store.getSnapshot();
    const snapshot = this.#ports?.media.getSnapshot();
    const state = this.#connection.getSnapshot().state;
    const local = Object.freeze({
      microphone: localMedia("microphone", this.#localTracks(), snapshot, this.#intent.microphone, state, this.#pendingSources.has("microphone")),
      camera: localMedia("camera", this.#localTracks(), snapshot, this.#intent.camera, state, this.#pendingSources.has("camera")),
      screen: localMedia("screen", this.#localTracks(), snapshot, false, state, this.#pendingSources.has("screen")),
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
  const track = tracks.get(source) ?? null;
  const publication = snapshot?.localTracks.find((candidate) => candidate.source === source);
  if (locallyMuted(intended, track, publication)) return Object.freeze({ source, state: "disabled" as const, track });
  if (pending) return Object.freeze({ source, state: "requesting" as const, track });
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
function isSyncRejection(cause: unknown): boolean {
  return isAccessInvalid(cause) || (cause instanceof V1SyncError && cause.code === "terminal_failure");
}
function canApplyForcedMediaState(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>): snapshot is ReturnType<ConnectionPorts["sync"]["getSnapshot"]> & {
  media: NonNullable<ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["media"]>;
  participantId: string;
} {
  return !!snapshot.media && !!snapshot.participantId && snapshot.control?.status !== "ended" && snapshot.connection.phase !== "terminal";
}
