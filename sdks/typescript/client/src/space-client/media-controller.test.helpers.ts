import { Clock, Duration, Effect, Layer, ManagedRuntime } from "effect";
import { vi } from "vitest";
import type { CloudflareSFUSnapshot } from "../media";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { ConnectionError } from "../connection/types";
import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";
import type { V1DirectedRequest } from "../sync";
import { MediaControllerService, makeMediaController } from "./media-controller";
import { MediaDeviceSelection } from "./media-device-selection";
import { SpaceStore } from "./store";

type FakeConnectionState = "idle" | "joining" | "live" | "reconnecting" | "leaving" | "left" | "failed";

export function createMediaControllerHarness(diagnostics?: EpisodeDiagnosticRuntime) {
  const connection = new FakeConnection();
  const media = new FakeMedia();
  const sync = new FakeSync(media);
  const ports = { media, sync } as unknown as ConnectionPorts;
  const getUserMedia = vi.fn(async () => stream());
  const getDisplayMedia = vi.fn(async () => stream());
  const enumerateDevices = vi.fn(async (): Promise<readonly MediaDeviceInfo[]> => []);
  const selectSpeaker = vi.fn(async () => undefined);
  const selection = new MediaDeviceSelection({ getUserMedia, getDisplayMedia, enumerateDevices, selectSpeaker });
  const store = new SpaceStore();
  const clock = Layer.succeed(Clock.Clock, {
    currentTimeMillisUnsafe: Date.now,
    currentTimeMillis: Effect.sync(Date.now),
    currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
    sleep: (duration: Duration.Duration) =>
      Effect.callback((resume) => {
        const handle = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        return Effect.sync(() => clearTimeout(handle));
      }),
  });
  const controllerLayer = Layer.effect(MediaControllerService, makeMediaController(connection as unknown as ConnectionLifecycleCapability, store, selection, diagnostics)).pipe(Layer.provide(clock)) as Layer.Layer<MediaControllerService, never>;
  const runtime = ManagedRuntime.make(controllerLayer);
  const native = runtime.runSync(Effect.service(MediaControllerService));
  const controller = {
    configure: (intent: Readonly<{ microphone?: boolean; camera?: boolean }>) => native.configure(intent),
    setMicrophoneEnabled: (enabled: boolean) => runtime.runPromise(native.setMicrophoneEnabled(enabled)),
    setCameraEnabled: (enabled: boolean) => runtime.runPromise(native.setCameraEnabled(enabled)),
    setScreenShareEnabled: (enabled: boolean) => runtime.runPromise(native.setScreenShareEnabled(enabled)),
    selectMicrophone: (deviceId: string) => runtime.runPromise(native.selectMicrophone(deviceId)),
    selectCamera: (deviceId: string) => runtime.runPromise(native.selectCamera(deviceId)),
    selectSpeaker: (deviceId: string) => runtime.runPromise(native.selectSpeaker(deviceId)),
    acceptRequest: (requestId: string) => runtime.runPromise(native.acceptRequest(requestId)),
    declineRequest: (requestId: string) => runtime.runPromise(native.declineRequest(requestId)),
  };
  return {
    controller,
    connection,
    enumerateDevices,
    getDisplayMedia,
    getUserMedia,
    media,
    selectSpeaker,
    store,
    sync,
    activate: () => {
      connection.setState("live");
      connection.setPorts(ports);
    },
  };
}

export class FakeTrack extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = "live";

  constructor(
    readonly id: string,
    readonly kind: "audio" | "video",
  ) {
    super();
  }

  stop(): void {
    this.readyState = "ended";
  }

  endFromBrowser(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

export function stream(...tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks as unknown as MediaStreamTrack[],
    getVideoTracks: () => tracks.filter((track) => track.kind === "video") as unknown as MediaStreamTrack[],
  } as MediaStream;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class FakeConnection {
  #initialMedia: ((intent: Readonly<{ microphone: boolean; camera: boolean }>) => Effect.Effect<MediaStream, unknown>) | null = null;
  #ports: ConnectionPorts | null = null;
  #state: FakeConnectionState = "idle";
  readonly #listeners = new Set<() => void>();
  readonly #portListeners = new Set<(ports: ConnectionPorts | null) => void>();
  readonly #screenListeners = new Set<() => void>();
  refreshes = 0;

  setInitialMedia(provider: (intent: Readonly<{ microphone: boolean; camera: boolean }>) => Effect.Effect<MediaStream, unknown>): Effect.Effect<void> {
    this.#initialMedia = provider;
    return Effect.void;
  }

  captureInitial(intent: Readonly<{ microphone: boolean; camera: boolean }>): Promise<MediaStream> {
    if (!this.#initialMedia) throw new TypeError("Initial media provider was not registered");
    return Effect.runPromise(this.#initialMedia(intent));
  }

  getSnapshot = () => ({ state: this.#state }) as ReturnType<ConnectionLifecycleCapability["getSnapshot"]>;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  subscribePorts = (listener: (ports: ConnectionPorts | null) => void): (() => void) => {
    this.#portListeners.add(listener);
    listener(this.#ports);
    return () => this.#portListeners.delete(listener);
  };
  subscribeScreenEnded = (listener: () => void): (() => void) => {
    this.#screenListeners.add(listener);
    return () => this.#screenListeners.delete(listener);
  };
  runCommand = <T>(operation: (ports: ConnectionPorts) => Effect.Effect<T, unknown>): Effect.Effect<T, unknown> =>
    Effect.suspend(() => {
      const ports = this.#ports;
      if (this.#state !== "live" || !ports) return Effect.fail(new ConnectionError({ code: "invalid_state", action: null, recoverable: false, message: "No live Connection ports" }));
      return operation(ports).pipe(
        Effect.catch((cause) =>
          isAccessInvalid(cause)
            ? Effect.sync(() => {
                this.refreshes += 1;
              }).pipe(Effect.andThen(operation(ports)))
            : Effect.fail(cause),
        ),
      );
    });

  setState(state: FakeConnectionState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  setPorts(ports: ConnectionPorts | null): void {
    this.#ports = ports;
    for (const listener of this.#portListeners) listener(ports);
  }

  leave(): void {
    this.setPorts(null);
    this.setState("left");
  }

  emitScreenEnded(): void {
    for (const listener of this.#screenListeners) listener();
  }
}

class FakeMedia {
  readonly #listeners = new Set<() => void>();
  readonly #localTracks = new Map<"microphone" | "camera" | "screen", MediaStreamTrack>();
  readonly #enabled = new Map<"microphone" | "camera" | "screen", boolean>();
  #remoteTracks: CloudflareSFUSnapshot["remoteTracks"] = [];
  #snapshot = mediaSnapshot(this.#localTracks, this.#enabled, this.#remoteTracks);
  readonly clearPreparedLocalTrack = vi.fn(async (source: "microphone" | "camera" | "screen") => {
    this.#localTracks.delete(source);
    this.#enabled.delete(source);
    this.#publish();
  });
  readonly prepareLocalTrack = vi.fn((source: "microphone" | "camera" | "screen", track: MediaStreamTrack) => {
    this.#localTracks.set(source, track);
    this.#enabled.set(source, false);
    this.#publish();
  });
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setEnabled(source: "microphone" | "camera" | "screen", enabled: boolean): void {
    this.#enabled.set(source, enabled);
    this.#publish();
  }

  setRemoteTracks(remoteTracks: CloudflareSFUSnapshot["remoteTracks"]): void {
    this.#remoteTracks = remoteTracks;
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = mediaSnapshot(this.#localTracks, this.#enabled, this.#remoteTracks);
    for (const listener of this.#listeners) listener();
  }
}

class FakeSync {
  readonly #listeners = new Set<(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>) => void>();
  readonly #requestListeners = new Set<(request: V1DirectedRequest) => void>();
  readonly #media: FakeMedia;
  #snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> = syncSnapshot();
  readonly setMicrophoneEnabled = vi.fn(async (enabled: boolean) => {
    this.#media.setEnabled("microphone", enabled);
    return mediaTargetResult();
  });
  readonly setCameraEnabled = vi.fn(async (enabled: boolean) => {
    this.#media.setEnabled("camera", enabled);
    return mediaTargetResult();
  });
  readonly setScreenShareEnabled = vi.fn(async (enabled: boolean) => {
    this.#media.setEnabled("screen", enabled);
    return mediaTargetResult();
  });

  constructor(media: FakeMedia) {
    this.#media = media;
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: (snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>) => void): (() => void) => {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  };
  onDirectedRequest = (listener: (request: V1DirectedRequest) => void): (() => void) => {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  };

  emitRequest(request: V1DirectedRequest): void {
    for (const listener of this.#requestListeners) listener(request);
  }

  setSnapshot(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function syncSnapshot(participantIds: readonly string[] = []): ReturnType<ConnectionPorts["sync"]["getSnapshot"]> {
  return {
    connection: { phase: "live" },
    participantId: "participant-self",
    participantGeneration: 1,
    control: {
      participants: participantIds.map((participantId) => ({ participantId, displayName: participantId === "participant-host" ? "Ada" : participantId })),
    },
    optimisticControl: null,
  } as unknown as ReturnType<ConnectionPorts["sync"]["getSnapshot"]>;
}

function mediaSnapshot(tracks: ReadonlyMap<"microphone" | "camera" | "screen", MediaStreamTrack>, enabled: ReadonlyMap<"microphone" | "camera" | "screen", boolean>, remoteTracks: CloudflareSFUSnapshot["remoteTracks"]): CloudflareSFUSnapshot {
  return {
    connection: { phase: "live", peerConnectionState: null, iceConnectionState: null },
    cursor: null,
    localTracks: [...tracks].map(([source, track]) => ({ source, enabled: enabled.get(source) ?? false, publicationId: `${source}-publication`, track })),
    remoteTracks,
    failure: null,
  };
}

function mediaTargetResult() {
  return { operationId: "operation-1", name: "set_microphone_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" } as const;
}

function isAccessInvalid(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as { readonly code?: unknown }).code === "access.invalid";
}
