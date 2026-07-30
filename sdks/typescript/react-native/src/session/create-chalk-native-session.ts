import {
  AsyncStorageV3PendingTargetStore,
  ChalkSession,
  CloudflareSFUClient,
  createChalkChatFileHttpTransport,
  createChalkWhiteboardV1Client,
  createChalkWhiteboardV1FileHttpTransport,
  createCloudflareSFUHTTPTransport,
  createReactNativeSyncLifecycle,
  createReactNativeWebSocketFactory,
  createV3SyncClient,
  type ChalkSessionChatFileFactoryInput,
  type ChalkSessionDependencies,
  type ChalkSessionMediaFactoryInput,
  type ChalkSessionOptions,
  type ChalkSessionSyncFactoryInput,
  type ChalkSessionWhiteboardFactoryInput,
  type ReactNativeWebSocket,
  type ReactNativeWebSocketConstructor,
  type ReactNativeAsyncStorage,
} from "@q9labsai/chalk-client";
import { RTCPeerConnection, mediaDevices } from "@cloudflare/react-native-webrtc";
import { AppState } from "react-native";

import { createNativeTelemetry, type NativeRtcPeerConnection, type NativeTelemetryJourney } from "../telemetry";

export type ChalkNativeSessionOptions = Omit<ChalkSessionOptions, "dependencies"> & {
  readonly storage?: ReactNativeAsyncStorage;
  readonly telemetry?: NativeTelemetryJourney;
};

export function createChalkNativeSession(options: ChalkNativeSessionOptions): ChalkSession {
  const { storage, telemetry: journey, ...sessionOptions } = options;
  const telemetry = journey ? createNativeTelemetry(journey) : undefined;
  const fetch = telemetryFetch(journey);
  const lifecycle = createReactNativeSyncLifecycle({ appState: AppState });
  const webSocket = createReactNativeWebSocketFactory(nativeWebSocketConstructor(journey));
  const dependencies: ChalkSessionDependencies = {
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
  };

  return new ChalkSession({
    ...sessionOptions,
    diagnostics: {
      ...options.diagnostics,
      onEvent: (event) => {
        options.diagnostics?.onEvent?.(event);
        options.telemetry?.recordDiagnostic({
          category: "session",
          code: event.event,
          phase: event.state === "joining" ? "signaling" : event.state === "leaving" || event.state === "left" ? "terminal" : "recovery",
          state: event.event.endsWith("_failed") || event.event.endsWith("_exhausted") ? "failed" : "observed",
        });
      },
    },
    dependencies,
  });
}

function createMediaClient(apiBaseURL: string, input: ChalkSessionMediaFactoryInput, fetch: typeof globalThis.fetch, observePeerConnection: ((peerConnection: NativeRtcPeerConnection) => () => void) | undefined) {
  const { subject } = input.access;
  return new CloudflareSFUClient({
    bootstrap: input.access.media.clientPayload,
    participantSessionId: subject.participantSessionId,
    replaceDormantConnection: input.replaceDormantConnection,
    transport: createCloudflareSFUHTTPTransport({
      apiBaseURL,
      credential: input.credential,
      tenantId: subject.tenantId,
      roomId: subject.roomId,
      sessionId: subject.sessionId,
      participantSessionId: subject.participantSessionId,
      fetch,
    }),
    peerConnectionFactory: (configuration) => {
      const connection = new RTCPeerConnection(configuration);
      observePeerConnection?.(connection as unknown as NativeRtcPeerConnection);
      return connection as unknown as globalThis.RTCPeerConnection;
    },
    onError: input.onFailure,
    onScreenEnded: input.onScreenEnded,
  });
}

function createSyncClient(syncURL: string, input: ChalkSessionSyncFactoryInput, lifecycle: ReturnType<typeof createReactNativeSyncLifecycle>, webSocket: ReturnType<typeof createReactNativeWebSocketFactory>, storage: ReactNativeAsyncStorage | undefined) {
  const subject = input.access.subject;
  const scope = `${subject.tenantId}:${subject.sessionId}:${subject.participantSessionId}`;
  return createV3SyncClient({
    url: syncURL,
    token: input.token,
    mediaPlane: input.media,
    lifecycle,
    webSocket,
    ...(storage ? { pendingStore: new AsyncStorageV3PendingTargetStore({ scope, storage }) } : {}),
  });
}

function createChatFileTransport(apiBaseURL: string, input: ChalkSessionChatFileFactoryInput, fetch: typeof globalThis.fetch) {
  return createChalkChatFileHttpTransport({ baseUrl: apiBaseURL, token: input.token, fetch });
}

function createWhiteboardClient(apiBaseURL: string, url: string, input: ChalkSessionWhiteboardFactoryInput, fetch: typeof globalThis.fetch, lifecycle: ReturnType<typeof createReactNativeSyncLifecycle>, webSocket: ReturnType<typeof createReactNativeWebSocketFactory>) {
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

function telemetryFetch(journey: NativeTelemetryJourney | undefined): typeof globalThis.fetch {
  if (!journey) return globalThis.fetch;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(journey.headers)) headers.set(name, value);
    return globalThis.fetch(input, { ...init, headers });
  };
}

function nativeWebSocketConstructor(journey: NativeTelemetryJourney | undefined): ReactNativeWebSocketConstructor {
  const RuntimeWebSocket = globalThis.WebSocket as unknown as new (url: string, protocols?: string | string[], options?: { readonly headers?: Readonly<Record<string, string>> }) => ReactNativeWebSocket;

  return class ChalkNativeWebSocket implements ReactNativeWebSocket {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    onclose: ((event: { readonly code?: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readonly #socket: ReactNativeWebSocket;

    constructor(url: string) {
      this.#socket = new RuntimeWebSocket(url, undefined, journey ? { headers: journey.headers } : undefined);
      this.#socket.onopen = (event) => this.onopen?.(event);
      this.#socket.onmessage = (event) => {
        recordSyncFrame(journey, "server_to_client", event.data);
        this.onmessage?.(event);
      };
      this.#socket.onclose = (event) => this.onclose?.(event);
      this.#socket.onerror = (event) => this.onerror?.(event);
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

function recordSyncFrame(journey: NativeTelemetryJourney | undefined, direction: "client_to_server" | "server_to_client", data: unknown): void {
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
