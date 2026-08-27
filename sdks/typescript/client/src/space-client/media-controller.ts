import { Clock, Context, Effect, Layer, Scope, Semaphore } from "effect";
import type { ConnectionMediaSnapshot, MediaSource } from "../media";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { requireDisplayVideoTrack, stopStream, streamFromTracks } from "../connection/media-devices";
import { ConnectionError } from "../connection/types";
import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";
import type { V1DirectedRequest } from "../sync";
import { normalizeClientError, SpaceClientError } from "./errors";
import type { MediaDeviceSelection } from "./media-device-selection";
import { SpaceStore } from "./store";
import type { IncomingMediaRequest, MediaSlice } from "./types";

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

export type MediaControllerEffects = {
  readonly configure: (intent: Readonly<{ microphone?: boolean; camera?: boolean }>) => void;
  readonly setMicrophoneEnabled: (enabled: boolean) => ClientEffect<void>;
  readonly setCameraEnabled: (enabled: boolean) => ClientEffect<void>;
  readonly setScreenShareEnabled: (enabled: boolean) => ClientEffect<void>;
  readonly selectMicrophone: (deviceId: string) => ClientEffect<void>;
  readonly selectCamera: (deviceId: string) => ClientEffect<void>;
  readonly selectSpeaker: (deviceId: string) => ClientEffect<void>;
  readonly acceptRequest: (requestId: string) => ClientEffect<void>;
  readonly declineRequest: (requestId: string) => ClientEffect<void>;
  readonly dispose: () => void;
};
export class MediaControllerService extends Context.Service<MediaControllerService, MediaControllerEffects>()("@chalk/client/MediaController") {}

/** Scoped media controller: all source work is serialized with Effect semaphores. */
export const makeMediaController = (connection: ConnectionLifecycleCapability, store: SpaceStore, selection: MediaDeviceSelection, diagnostics?: EpisodeDiagnosticRuntime): Effect.Effect<MediaControllerEffects, never, Clock.Clock | Scope.Scope> =>
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
      diagnostics,
    );
    yield* connection.setInitialMedia((intent) => controller.captureInitial(intent));
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    controller.refreshDevicesInBackground();
    return controller;
  });

export const makeMediaControllerLayer = (connection: ConnectionLifecycleCapability, store: SpaceStore, selection: MediaDeviceSelection, diagnostics?: EpisodeDiagnosticRuntime) => Layer.effect(MediaControllerService, makeMediaController(connection, store, selection, diagnostics));

class MediaControllerRuntime implements MediaControllerEffects {
  readonly #connection: ConnectionLifecycleCapability;
  readonly #selection: MediaDeviceSelection;
  readonly #store: SpaceStore;
  readonly #gates: ReadonlyMap<MediaSource, Semaphore.Semaphore>;
  readonly #now: () => number;
  readonly #fork: Fork;
  readonly #diagnostics: EpisodeDiagnosticRuntime | undefined;
  readonly #tracks = new Map<MediaSource, MediaStreamTrack>();
  readonly #requestGenerations = new Map<string, number>();
  #intent = { microphone: true, camera: true };
  #requests: readonly IncomingMediaRequest[] = Object.freeze([]);
  #ports: ConnectionPorts | null = null;
  #screenEndedPending = false;
  #unsubscribeMedia: (() => void) | null = null;
  #unsubscribeRequests: (() => void) | null = null;
  #unsubscribeSync: (() => void) | null = null;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeScreenEnded: (() => void) | null = null;
  #unsubscribePorts: (() => void) | null = null;

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, selection: MediaDeviceSelection, gates: ReadonlyMap<MediaSource, Semaphore.Semaphore>, now: () => number, fork: Fork, diagnostics?: EpisodeDiagnosticRuntime) {
    this.#connection = connection;
    this.#store = store;
    this.#selection = selection;
    this.#gates = gates;
    this.#now = now;
    this.#fork = fork;
    this.#diagnostics = diagnostics;
    this.#unsubscribeConnection = connection.subscribe(() => this.#handleConnectionChange());
    this.#unsubscribeScreenEnded = connection.subscribeScreenEnded(() => this.#handleScreenEnded());
    this.#unsubscribePorts = connection.subscribePorts((ports) => this.#bind(ports));
  }

  configure(intent: Readonly<{ microphone?: boolean; camera?: boolean }>): void {
    if (intent.microphone !== undefined) this.#intent.microphone = intent.microphone;
    if (intent.camera !== undefined) this.#intent.camera = intent.camera;
  }
  setMicrophoneEnabled = (enabled: boolean): ClientEffect<void> => this.#set("microphone", enabled);
  setCameraEnabled = (enabled: boolean): ClientEffect<void> => this.#set("camera", enabled);
  setScreenShareEnabled = (enabled: boolean): ClientEffect<void> => (enabled ? this.#startScreen() : this.#stopScreen());
  selectMicrophone = (deviceId: string): ClientEffect<void> =>
    Effect.sync(() => {
      this.#selection.selectCapture("microphone", deviceId);
      this.#store.select("microphone", deviceId);
    }).pipe(Effect.mapError(normalizeClientError));
  selectCamera = (deviceId: string): ClientEffect<void> =>
    Effect.sync(() => {
      this.#selection.selectCapture("camera", deviceId);
      this.#store.select("camera", deviceId);
    }).pipe(Effect.mapError(normalizeClientError));
  selectSpeaker = (deviceId: string): ClientEffect<void> =>
    foreign(() => this.#selection.selectSpeaker(deviceId)).pipe(
      Effect.tap(() => Effect.sync(() => this.#store.select("speaker", deviceId))),
      Effect.mapError(normalizeClientError),
    );
  acceptRequest = (requestId: string): ClientEffect<void> => {
    const operation = this.#diagnostics?.startOperation("media_request.accept");
    return Effect.suspend(() => {
      const request = this.#requests.find((candidate) => candidate.requestId === requestId);
      if (!request) return Effect.fail(new SpaceClientError({ code: "media.request_invalid", recoverable: false, message: "The media request is no longer active" }));
      operation?.observe("observed", "capability_decision");
      return (request.kind === "unmute" ? this.#set("microphone", true) : this.#set("camera", true)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.#removeRequest(requestId);
            operation?.observe("observed", "command_commit");
            operation?.observe("observed", "target_result");
            operation?.succeed();
          }),
        ),
        Effect.tapError(() => Effect.sync(() => operation?.fail("accept_failed"))),
      );
    }).pipe(
      Effect.mapError(normalizeClientError),
      Effect.tapError(() => Effect.sync(() => operation?.fail("accept_failed"))),
    );
  };
  declineRequest = (requestId: string): ClientEffect<void> => {
    const operation = this.#diagnostics?.startOperation("media_request.decline");
    return Effect.sync(() => {
      operation?.observe("observed", "capability_decision");
      this.#removeRequest(requestId);
      operation?.notObservable("command_commit", "decline_is_local_only");
      operation?.observe("observed", "target_result");
      operation?.succeed();
    }).pipe(
      Effect.mapError(normalizeClientError),
      Effect.tapError(() => Effect.sync(() => operation?.fail("decline_failed"))),
    );
  };

  captureInitial(_intent: Readonly<{ microphone: boolean; camera: boolean }>): Effect.Effect<MediaStream, unknown> {
    if (!this.#intent.microphone && !this.#intent.camera) return Effect.succeed(streamFromTracks([]));
    return foreign(() => this.#selection.getUserMedia({ audio: this.#intent.microphone, video: this.#intent.camera })).pipe(
      Effect.flatMap((stream) =>
        Effect.try({ try: () => selectInitialTracks(stream, this.#intent), catch: (cause) => cause }).pipe(
          Effect.tap((tracks) =>
            Effect.sync(() => {
              for (const [source, track] of tracks) this.#tracks.set(source, track);
              this.#publish();
            }),
          ),
          Effect.tap(() => this.#refreshDevices().pipe(Effect.ignore)),
          Effect.map(() => streamFromTracks([...this.#tracks.values()])),
          Effect.catch((cause) =>
            Effect.sync(() => {
              stopStream(stream);
              this.#publish();
            }).pipe(Effect.andThen(Effect.fail(captureError(cause, "join", "Camera or microphone permission was denied")))),
          ),
        ),
      ),
      Effect.catch((cause) => Effect.fail(cause instanceof ConnectionError ? cause : captureError(cause, "join", "Camera or microphone permission was denied"))),
    );
  }

  refreshDevicesInBackground(): void {
    this.#fork(this.#refreshDevices().pipe(Effect.ignore));
  }
  dispose(): void {
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
    for (const track of this.#tracks.values()) track.stop();
    this.#tracks.clear();
    this.#clearRequests();
    this.#publish();
  }

  #set(source: "microphone" | "camera", enabled: boolean): ClientEffect<void> {
    const operation = this.#diagnostics?.startOperation(`${source}.${enabled ? "publish" : "unpublish"}`);
    operation?.observe("observed", "intent");
    return this.#serialize(
      source,
      this.#connection.runCommand((ports) => {
        const previousIntent = this.#intent[source];
        this.#intent[source] = enabled;
        let captured: MediaStreamTrack | null = null;
        let prepared = false;
        const action = source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled";
        return Effect.suspend(() => {
          const acquire =
            enabled && !this.#tracks.has(source)
              ? this.#captureSource(source).pipe(
                  Effect.tap((track) =>
                    Effect.sync(() => {
                      captured = track;
                      try {
                        this.#assertActivePorts(ports, action);
                      } catch (cause) {
                        track.stop();
                        throw cause;
                      }
                      this.#tracks.set(source, track);
                      ports.media.prepareLocalTrack(source, track);
                      prepared = true;
                      operation?.observe("observed", "local_track_state");
                      this.#publish();
                    }),
                  ),
                )
              : Effect.void;
          return acquire.pipe(
            Effect.asVoid,
            Effect.tap(() => Effect.sync(() => operation?.observe("observed", "local_track_state"))),
            Effect.andThen(source === "microphone" ? foreign(() => ports.sync.setMicrophoneEnabled(enabled)) : foreign(() => ports.sync.setCameraEnabled(enabled))),
            Effect.tap(() => Effect.sync(() => operation?.observe("observed", "sync_commit"))),
            Effect.tap(() => Effect.sync(() => this.#assertActivePorts(ports, action))),
            Effect.tap(() =>
              Effect.sync(() => {
                operation?.observe("observed", "sfu_publication");
                operation?.succeed();
              }),
            ),
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
                  this.#intent[source] = previousIntent;
                },
                source,
                track: captured,
              }),
            ),
          );
        });
      }),
    ).pipe(
      Effect.mapError(normalizeClientError),
      Effect.tapError(() => Effect.sync(() => operation?.fail("media_failed"))),
    );
  }

  #startScreen(): ClientEffect<void> {
    const operation = this.#diagnostics?.startOperation("screen.start");
    return this.#serialize(
      "screen",
      this.#connection.runCommand((ports) => {
        let stream: MediaStream | null = null;
        let track: MediaStreamTrack | null = null;
        let prepared = false;
        return Effect.suspend(() => {
          if (this.#tracks.has("screen")) {
            operation?.notObservable("permission", "already_active");
            operation?.notObservable("track_acquisition", "already_active");
            operation?.notObservable("sync_commit", "already_active");
            operation?.notObservable("sfu_publication", "already_active");
            operation?.succeed();
            return Effect.void;
          }
          return foreign(() => this.#selection.getDisplayMedia({ video: true, audio: false })).pipe(
            Effect.tap(() => Effect.sync(() => operation?.observe("observed", "permission"))),
            Effect.tap((captured) =>
              Effect.sync(() => {
                stream = captured;
                this.#assertActivePorts(ports, "startScreenShare");
                track = requireDisplayVideoTrack(captured);
                this.#tracks.set("screen", track);
                ports.media.prepareLocalTrack("screen", track);
                prepared = true;
                operation?.observe("observed", "track_acquisition");
                track.addEventListener("ended", () => this.#handleScreenEnded(track!));
                this.#screenEndedPending = false;
                this.#publish();
              }),
            ),
            Effect.andThen(foreign(() => ports.sync.setScreenShareEnabled(true))),
            Effect.tap(() => Effect.sync(() => operation?.observe("observed", "sync_commit"))),
            Effect.tap(() => Effect.sync(() => this.#assertActivePorts(ports, "startScreenShare"))),
            Effect.tap(() =>
              Effect.sync(() => {
                operation?.observe("observed", "sfu_publication");
                operation?.succeed();
              }),
            ),
            Effect.asVoid,
            Effect.catch((cause) => this.#rollbackCapture({ action: "startScreenShare", cause, fallback: Effect.sync(() => stopStream(stream)), media: ports.media, permissionMessage: "Screen sharing permission was denied", prepared, source: "screen", track })),
          );
        });
      }),
    ).pipe(
      Effect.mapError(normalizeClientError),
      Effect.tapError(() => Effect.sync(() => operation?.fail("screen_start_failed"))),
    );
  }

  #stopScreen(): ClientEffect<void> {
    const operation = this.#diagnostics?.startOperation("screen.stop");
    return this.#serialize(
      "screen",
      this.#connection.runCommand((ports) =>
        Effect.suspend(() => {
          const track = this.#tracks.get("screen");
          if (!track) {
            operation?.notObservable("stop_confirmation", "already_stopped");
            operation?.succeed();
            return Effect.void;
          }
          return foreign(() => ports.sync.setScreenShareEnabled(false)).pipe(
            Effect.tap(() => Effect.sync(() => this.#assertActivePorts(ports, "stopScreenShare"))),
            Effect.andThen(foreign(() => ports.media.clearPreparedLocalTrack("screen"))),
            Effect.tap(() =>
              Effect.sync(() => {
                this.#assertActivePorts(ports, "stopScreenShare");
                if (this.#tracks.get("screen") === track) this.#tracks.delete("screen");
                track.stop();
                this.#screenEndedPending = false;
                this.#publish();
                operation?.observe("observed", "stop_confirmation");
                operation?.succeed();
              }),
            ),
            Effect.asVoid,
          );
        }),
      ),
    ).pipe(
      Effect.mapError(normalizeClientError),
      Effect.tapError(() => Effect.sync(() => operation?.fail("screen_stop_failed"))),
    );
  }

  #serialize<A>(source: MediaSource, effect: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    return this.#gates.get(source)!.withPermit(effect);
  }
  #captureSource(source: "microphone" | "camera"): Effect.Effect<MediaStreamTrack, unknown> {
    return foreign(() => this.#selection.getUserMedia({ audio: source === "microphone", video: source === "camera" })).pipe(
      Effect.tap(() => this.#refreshDevices().pipe(Effect.ignore)),
      Effect.flatMap((stream) =>
        Effect.try({
          try: () => {
            const track = stream.getTracks().find((candidate) => candidate.kind === (source === "microphone" ? "audio" : "video"));
            if (!track) {
              stopStream(stream);
              throw new TypeError(`Media capture did not return a ${source} track`);
            }
            for (const candidate of stream.getTracks()) if (candidate !== track) candidate.stop();
            return track;
          },
          catch: (cause) => cause,
        }),
      ),
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
          if (this.#tracks.get(source) === track) this.#tracks.delete(source);
          track.stop();
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
    this.#ports = ports;
    if (!ports) {
      for (const track of this.#tracks.values()) track.stop();
      this.#tracks.clear();
      this.#screenEndedPending = false;
      this.#clearRequests();
      this.#publish();
      return;
    }
    this.#unsubscribeMedia = ports.media.subscribe(() => this.#publish());
    this.#unsubscribeRequests = ports.sync.onDirectedRequest((request) => this.#request(request));
    this.#unsubscribeSync = ports.sync.subscribe((snapshot) => this.#removeRequestsFromMissingParticipants(snapshot));
    this.#publish();
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
  #handleScreenEnded(track = this.#tracks.get("screen")): void {
    if (!track || this.#tracks.get("screen") !== track) return;
    if (this.#connection.getSnapshot().state === "reconnecting") {
      this.#screenEndedPending = true;
      return;
    }
    const operation = this.#diagnostics?.startOperation("screen.unexpected_end");
    operation?.observe("observed", "track_end");
    this.#fork(
      this.#stopScreen().pipe(
        Effect.tap(() => Effect.sync(() => operation?.succeed())),
        Effect.tapError(() => Effect.sync(() => operation?.fail("screen_stop_failed"))),
        Effect.ignore,
      ),
    );
  }
  #publish(): void {
    const current = this.#store.getSnapshot();
    const snapshot = this.#ports?.media.getSnapshot();
    const state = this.#connection.getSnapshot().state;
    const local = Object.freeze({ microphone: localMedia("microphone", this.#tracks, snapshot, this.#intent.microphone, state), camera: localMedia("camera", this.#tracks, snapshot, this.#intent.camera, state), screen: localMedia("screen", this.#tracks, snapshot, false, state) });
    const remote = Object.freeze((snapshot?.remoteTracks ?? []).map((track) => Object.freeze({ participantId: track.participantId, source: track.source, publicationId: track.publicationId, track: track.track })));
    const media = Object.freeze({ ...current.media, local, remote, screenShare: local.screen, incomingRequests: this.#requests });
    if (!sameMediaSlice(current.media, media)) this.#store.updateMedia(media);
  }
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
function localMedia(source: MediaSource, tracks: ReadonlyMap<MediaSource, MediaStreamTrack>, snapshot: ConnectionMediaSnapshot | undefined, intended: boolean, connectionState: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>["state"]) {
  const track = tracks.get(source) ?? null;
  const publication = snapshot?.localTracks.find((candidate) => candidate.source === source);
  if (publication?.enabled) return Object.freeze({ source, state: "enabled" as const, track });
  return Object.freeze({ source, state: localMediaState(source, track, intended, connectionState), track });
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
  return sameLocalMedia(left.screenShare, right.screenShare) && sameRemoteMedia(left.remote, right.remote) && sameRequests(left.incomingRequests, right.incomingRequests);
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
  if (isPermissionDenied(cause)) return new ConnectionError({ code: "permission_denied", action, recoverable: true, message: permissionMessage }, { cause });
  return new ConnectionError({ code: "unsupported_environment", action, recoverable: false, message: action === "startScreenShare" ? "Screen sharing is unavailable in this browser." : "Media capture is unavailable" }, { cause });
}
function isPermissionDenied(cause: unknown): boolean {
  return cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
}
function isAccessInvalid(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && ((cause as { readonly code?: unknown }).code === "access.invalid" || (cause as { readonly code?: unknown }).code === "invalid_access");
}
