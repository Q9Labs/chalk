import {
  AsyncStorageV1PendingTargetStore,
  CloudflareSFUClient,
  createChalkChatFileHttpTransport,
  createChalkWhiteboardV1Client,
  createChalkWhiteboardV1FileHttpTransport,
  createCloudflareSFUHTTPTransport,
  createReactNativeSyncLifecycle,
  createReactNativeWebSocketFactory,
  createV1SyncClient,
  type AccessGrant,
  type DiagnosticObservation,
  type GetAccess,
  type ReactNativeWebSocket,
  type ReactNativeWebSocketConstructor,
  type ReactNativeAsyncStorage,
} from "../client-compat";
import { createSpaceClientForPlatform, type SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import { RTCPeerConnection, mediaDevices } from "@cloudflare/react-native-webrtc";
import { AppState } from "react-native";

import { createTelemetry, syncTransportCloseDiagnostic, type RtcPeerConnection, type TelemetryJourney } from "../telemetry";
import { SpaceClientAdapter, type ChalkSessionStore } from "../client-compat";
import { connectionAccessFor } from "./create-client-session";

type PlatformDependencies = NonNullable<SpaceClientPlatform["dependencies"]>;
type MediaFactoryInput = Parameters<NonNullable<PlatformDependencies["createMediaClient"]>>[0];
type SyncFactoryInput = Parameters<NonNullable<PlatformDependencies["createSyncClient"]>>[0];
type ChatFileFactoryInput = Parameters<NonNullable<PlatformDependencies["createChatFileTransport"]>>[0];
type WhiteboardFactoryInput = Parameters<NonNullable<PlatformDependencies["createWhiteboardClient"]>>[0];

export type ChalkSessionOptions = {
  readonly space?: string;
  readonly getAccess?: GetAccess;
  readonly access?: () => AccessGrant | Promise<AccessGrant>;
  readonly apiBaseURL: string;
  readonly syncURL: string;
  readonly whiteboardURL?: string | null;
  readonly initialMicrophoneEnabled?: boolean;
  readonly initialCameraEnabled?: boolean;
  readonly syncStartupTimeoutMs?: number;
  readonly storage?: ReactNativeAsyncStorage;
  readonly telemetry?: TelemetryJourney;
};

export function createChalkSession(options: ChalkSessionOptions): ChalkSessionStore {
  const { storage, telemetry: journey } = options;
  const telemetry = journey ? createTelemetry(journey) : undefined;
  const fetch = telemetryFetch(journey);
  const lifecycle = createReactNativeSyncLifecycle({ appState: AppState });
  const webSocket = createReactNativeWebSocketFactory(nativeWebSocketConstructor(journey));
  const dependencies: PlatformDependencies = {
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    },
    mediaDevices: {
      getUserMedia: async (constraints) => (await mediaDevices.getUserMedia(constraints)) as unknown as globalThis.MediaStream,
      getDisplayMedia: async () => (await mediaDevices.getDisplayMedia()) as unknown as globalThis.MediaStream,
    },
    createMediaClient: (input) => createMediaClient(options.apiBaseURL, input, fetch, telemetry?.observePeerConnection),
    createSyncClient: (input) => createSyncClient(options.syncURL, input, lifecycle, webSocket, storage),
    createChatFileTransport: (input) => createChatFileTransport(options.apiBaseURL, input, fetch),
    createWhiteboardClient: options.whiteboardURL === null ? undefined : (input) => createWhiteboardClient(options.apiBaseURL, options.whiteboardURL ?? whiteboardURL(options.syncURL), input, fetch, lifecycle, webSocket),
    subscribeForeground: (listener) => {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") listener();
      });
      return () => subscription.remove();
    },
  };

  const getAccess: GetAccess =
    options.getAccess ??
    (async () => {
      if (!options.access) throw new TypeError("getAccess or access is required");
      return options.access();
    });
  const connectionAccess = connectionAccessFor(getAccess);
  const client = createSpaceClientForPlatform(
    { space: options.space ?? "native-space", getAccess, baseUrl: options.apiBaseURL },
    {
      apiBaseUrl: options.apiBaseURL,
      syncUrl: options.syncURL,
      whiteboardUrl: options.whiteboardURL,
      dependencies,
      fetch,
      syncStartupTimeoutMs: options.syncStartupTimeoutMs ?? 30_000,
      initialMicrophoneEnabled: options.initialMicrophoneEnabled,
      initialCameraEnabled: options.initialCameraEnabled,
      onConnectionDiagnostic: (event) => journey?.recordDiagnostic(connectionDiagnostic(event)),
      ...(connectionAccess ? { connectionAccess } : {}),
    },
  );
  return new SpaceClientAdapter(client);
}

type PlatformDiagnostic = Parameters<NonNullable<SpaceClientPlatform["onConnectionDiagnostic"]>>[0];

function connectionDiagnostic(event: PlatformDiagnostic): DiagnosticObservation {
  if (event.event === "join_span" && event.step && event.spanId && event.outcome) {
    return {
      category: "session",
      code: `join.${event.step}.${event.outcome}`,
      phase: joinTracePhase(event.step),
      state: event.outcome === "succeeded" ? "succeeded" : event.outcome === "failed" ? "failed" : "observed",
      ...(event.durationMs === undefined ? {} : { metricValue: event.durationMs }),
      attributes: {
        span_id: event.spanId,
        ...(event.parentSpanId ? { parent_span_id: event.parentSpanId } : {}),
        step: event.step,
        outcome: event.outcome,
        epoch: event.epoch,
        ...(event.code ? { failure_code: event.code } : {}),
      },
    };
  }
  return {
    category: "session",
    code: event.event,
    phase: event.state === "joining" ? "signaling" : event.state === "leaving" || event.state === "left" ? "terminal" : "recovery",
    state: event.event.endsWith("_failed") || event.event.endsWith("_exhausted") ? "failed" : "observed",
  };
}

function joinTracePhase(step: NonNullable<PlatformDiagnostic["step"]>): "authentication" | "signaling" | "media" | "recovery" {
  switch (step) {
    case "acquire_initial_media":
    case "create_media_client":
    case "start_media":
      return "media";
    default:
      return "signaling";
  }
}

function createMediaClient(apiBaseURL: string, input: MediaFactoryInput, fetch: typeof globalThis.fetch, observePeerConnection: ((peerConnection: RtcPeerConnection) => () => void) | undefined) {
  const { subject } = input.access;
  return new CloudflareSFUClient({
    bootstrap: input.access.media.clientPayload,
    participantId: subject.participantId,
    transport: createCloudflareSFUHTTPTransport({
      apiBaseURL,
      credential: input.credential,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      episodeId: subject.episodeId,
      participantId: subject.participantId,
      fetch,
    }),
    peerConnectionFactory: (configuration) => {
      const connection = new RTCPeerConnection(configuration);
      observePeerConnection?.(connection as unknown as RtcPeerConnection);
      return connection as unknown as globalThis.RTCPeerConnection;
    },
    onError: input.onFailure,
    onScreenEnded: input.onScreenEnded,
  });
}

function createSyncClient(syncURL: string, input: SyncFactoryInput, lifecycle: ReturnType<typeof createReactNativeSyncLifecycle>, webSocket: ReturnType<typeof createReactNativeWebSocketFactory>, storage: ReactNativeAsyncStorage | undefined) {
  const subject = input.access.subject;
  const scope = `${subject.tenantId}:${subject.episodeId}:${subject.participantId}`;
  return createV1SyncClient({
    url: syncURL,
    token: input.token,
    mediaPlane: input.media,
    lifecycle,
    webSocket,
    ...(storage ? { pendingStore: new AsyncStorageV1PendingTargetStore({ scope, storage }) } : {}),
  });
}

function createChatFileTransport(apiBaseURL: string, input: ChatFileFactoryInput, fetch: typeof globalThis.fetch) {
  return createChalkChatFileHttpTransport({ baseUrl: apiBaseURL, token: input.token, fetch });
}

function createWhiteboardClient(apiBaseURL: string, url: string, input: WhiteboardFactoryInput, fetch: typeof globalThis.fetch, lifecycle: ReturnType<typeof createReactNativeSyncLifecycle>, webSocket: ReturnType<typeof createReactNativeWebSocketFactory>) {
  let sceneId: string | null = null;
  const files = createChalkWhiteboardV1FileHttpTransport({
    baseUrl: apiBaseURL,
    token: input.token,
    sceneId: () => {
      if (sceneId === null) throw new TypeError("Whiteboard scene is not ready");
      return sceneId;
    },
    fetch,
  });
  return createChalkWhiteboardV1Client({
    url,
    token: input.token,
    files,
    lifecycle,
    webSocket,
    onSummary: (summary) => {
      sceneId = summary.sceneId;
      input.onSummary(summary);
    },
  });
}

function telemetryFetch(journey: TelemetryJourney | undefined): typeof globalThis.fetch {
  if (!journey) return globalThis.fetch;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(journey.headers)) headers.set(name, value);
    return globalThis.fetch(input, { ...init, headers });
  };
}

function nativeWebSocketConstructor(journey: TelemetryJourney | undefined): ReactNativeWebSocketConstructor {
  const RuntimeWebSocket = globalThis.WebSocket as unknown as new (url: string, protocols?: string | string[], options?: { readonly headers?: Readonly<Record<string, string>> }) => ReactNativeWebSocket;

  return class ChalkNativeWebSocket implements ReactNativeWebSocket {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    onclose: ((event: { readonly code?: unknown; readonly reason?: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readonly #socket: ReactNativeWebSocket;

    constructor(url: string) {
      this.#socket = new RuntimeWebSocket(url, undefined, journey ? { headers: journey.headers } : undefined);
      this.#socket.onopen = (event) => this.onopen?.(event);
      this.#socket.onmessage = (event) => {
        recordSyncFrame(journey, "server_to_client", event.data);
        this.onmessage?.(event);
      };
      this.#socket.onclose = (event) => {
        recordSyncTransportClose(journey, event);
        this.onclose?.(event);
      };
      this.#socket.onerror = (event) => {
        journey?.recordDiagnostic({ category: "network", code: "sync_websocket_error", phase: "signaling", state: "failed" });
        this.onerror?.(event);
      };
    }

    send(data: string): void {
      recordSyncFrame(journey, "client_to_server", data);
      this.#socket.send(data);
    }

    close(code?: number, reason?: string): void {
      this.#socket.close(code, reason);
    }
  };
}

function recordSyncTransportClose(journey: TelemetryJourney | undefined, event: { readonly code?: unknown; readonly reason?: unknown }): void {
  if (!journey) return;
  journey.recordDiagnostic(syncTransportCloseDiagnostic(event));
}

function recordSyncFrame(journey: TelemetryJourney | undefined, direction: "client_to_server" | "server_to_client", data: unknown): void {
  if (!journey) return;
  let frameType = "binary";
  if (typeof data === "string") {
    try {
      const frame = JSON.parse(data) as { readonly type?: unknown };
      frameType = typeof frame.type === "string" ? frame.type : "unknown";
    } catch {
      frameType = "invalid_json";
    }
  }
  journey.recordSyncFrame({ direction, frameType });
}

function whiteboardURL(syncURL: string): string {
  const url = new URL(syncURL);
  url.pathname = "/v1/whiteboard";
  url.search = "";
  url.hash = "";
  return url.toString();
}
