import {
  AsyncStorageV1PendingTargetStore,
  CloudflareRTKClient,
  CloudflareSFUClient,
  createChalkChatFileHttpTransport,
  createChalkWhiteboardV1Client,
  createChalkWhiteboardV1FileHttpTransport,
  createCloudflareSFUHTTPTransport,
  createReactNativeSyncLifecycle,
  createReactNativeWebSocketFactory,
  createV1SyncClient,
  type DiagnosticObservation,
  type GetAccess,
  type ReactNativeWebSocket,
  type ReactNativeWebSocketConstructor,
  type ReactNativeAsyncStorage,
} from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform, type SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import type { SpaceClient } from "@q9labsai/chalk-client";
import { RTCPeerConnection, mediaDevices } from "@cloudflare/react-native-webrtc";
import { AppState } from "react-native";

import { authenticatedNativeCredential, bindNativeAuthenticatedTelemetry, createTelemetry, registerNativeJourneyContext, syncTransportCloseDiagnostic, type RtcPeerConnection, type TelemetryJourney } from "../telemetry";
import { createNativeRealtimeKitClient } from "./cloudflare-rtk-native";

type PlatformDependencies = NonNullable<SpaceClientPlatform["dependencies"]>;
type NativeMediaClient = ReturnType<NonNullable<PlatformDependencies["createMediaClient"]>>;
type MediaFactoryInput = Parameters<NonNullable<PlatformDependencies["createMediaClient"]>>[0];
type SyncFactoryInput = Parameters<NonNullable<PlatformDependencies["createSyncClient"]>>[0];
type ChatFileFactoryInput = Parameters<NonNullable<PlatformDependencies["createChatFileTransport"]>>[0];
type WhiteboardFactoryInput = Parameters<NonNullable<PlatformDependencies["createWhiteboardClient"]>>[0];

export type NativeSpaceClientOptions = {
  readonly space: string;
  readonly getAccess: GetAccess;
  readonly baseUrl?: string;
  readonly syncUrl?: string;
  readonly whiteboardURL?: string | null;
  readonly microphone?: boolean;
  readonly camera?: boolean;
  readonly syncStartupTimeoutMs?: number;
  readonly storage?: ReactNativeAsyncStorage;
  readonly telemetry?: TelemetryJourney;
};

export function createNativeSpaceClient(options: NativeSpaceClientOptions): SpaceClient {
  const { storage, telemetry: journey } = options;
  const apiBaseURL = options.baseUrl ?? "https://api.chalkmeet.com";
  const syncURL = options.syncUrl ?? defaultSyncURL(apiBaseURL);
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
    createMediaClient: (input) => createMediaClient(apiBaseURL, input, fetch, telemetry?.observePeerConnection, journey),
    createSyncClient: (input) => createSyncClient(syncURL, input, lifecycle, webSocket, storage),
    createChatFileTransport: (input) => createChatFileTransport(apiBaseURL, input, fetch),
    createWhiteboardClient: options.whiteboardURL === null ? undefined : (input) => createWhiteboardClient(apiBaseURL, options.whiteboardURL ?? whiteboardURL(syncURL), input, fetch, lifecycle, webSocket),
    subscribeForeground: (listener) => {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") listener();
      });
      return () => subscription.remove();
    },
  };

  const client = createSpaceClientForPlatform(
    { space: options.space, getAccess: options.getAccess, baseUrl: apiBaseURL },
    {
      apiBaseUrl: apiBaseURL,
      syncUrl: syncURL,
      whiteboardUrl: options.whiteboardURL,
      telemetry: journey?.context,
      dependencies,
      fetch,
      syncStartupTimeoutMs: options.syncStartupTimeoutMs ?? 30_000,
      initialMicrophoneEnabled: options.microphone,
      initialCameraEnabled: options.camera,
      onConnectionDiagnostic: (event) => journey?.recordDiagnostic(connectionDiagnostic(event)),
    },
  );
  bindNativeAuthenticatedTelemetry(client, journey);
  registerNativeJourneyContext(client, journey, telemetry);
  return client;
}

type PlatformDiagnostic = Parameters<NonNullable<SpaceClientPlatform["onConnectionDiagnostic"]>>[0];

function connectionDiagnostic(event: PlatformDiagnostic): DiagnosticObservation {
  if (event.event === "space_join_span" && event.step && event.spanId && event.outcome) {
    return {
      category: "connection",
      code: `space.join.${event.step}.${event.outcome}`,
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
    category: "connection",
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

function createMediaClient(apiBaseURL: string, input: MediaFactoryInput, fetch: typeof globalThis.fetch, observePeerConnection: ((peerConnection: RtcPeerConnection) => () => void) | undefined, journey: TelemetryJourney | undefined): NativeMediaClient {
  const { subject } = input.access;
  if (input.access.media.provider === "cloudflare_rtk") {
    const client = new CloudflareRTKClient({
      authToken: input.access.media.clientPayload.token,
      participantId: subject.participantId,
      clientFactory: createNativeRealtimeKitClient,
      onError: input.onFailure,
      onScreenEnded: input.onScreenEnded,
    });
    return createRTKConnectionMediaClient(client);
  }
  const replaceMediaConnection = input.replaceMediaConnection;
  const client = new CloudflareSFUClient({
    bootstrap: input.access.media.clientPayload,
    participantId: subject.participantId,
    transport: createCloudflareSFUHTTPTransport({
      apiBaseURL,
      credential: () => authenticatedNativeCredential(input.credential, journey),
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      episodeId: subject.episodeId,
      participantId: subject.participantId,
      fetch,
    }),
    replaceMediaConnection: replaceMediaConnection
      ? async () => {
          const replacement = await replaceMediaConnection();
          if (replacement.provider !== "cloudflare_sfu") throw new TypeError("The Cloudflare SFU adapter requires a Cloudflare SFU access grant");
          return replacement.clientPayload;
        }
      : undefined,
    peerConnectionFactory: (configuration) => {
      const connection = new RTCPeerConnection(configuration);
      observePeerConnection?.(connection as unknown as RtcPeerConnection);
      return connection as unknown as globalThis.RTCPeerConnection;
    },
    onError: input.onFailure,
    onScreenEnded: input.onScreenEnded,
  });
  return createSFUConnectionMediaClient(client);
}

function createRTKConnectionMediaClient(client: CloudflareRTKClient): NativeMediaClient {
  return {
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
    start: client.start.bind(client),
    stop: client.stop.bind(client),
    restart: (input) => {
      if (!("provider" in input) || input.provider !== "cloudflare_rtk") throw new TypeError("The RealtimeKit adapter requires a Cloudflare RealtimeKit access grant");
      return client.restart(input);
    },
    prepareLocalTrack: client.prepareLocalTrack.bind(client),
    clearPreparedLocalTrack: client.clearPreparedLocalTrack.bind(client),
    getSnapshot: client.getSnapshot.bind(client),
    subscribe: client.subscribe.bind(client),
  };
}

function createSFUConnectionMediaClient(client: CloudflareSFUClient): NativeMediaClient {
  return {
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
    start: client.start.bind(client),
    stop: client.stop.bind(client),
    restart: (input) => {
      if ("provider" in input) {
        if (input.provider !== "cloudflare_sfu") throw new TypeError("The Cloudflare SFU adapter requires a Cloudflare SFU access grant");
        return client.restart(input.clientPayload);
      }
      return client.restart(input);
    },
    prepareLocalTrack: client.prepareLocalTrack.bind(client),
    clearPreparedLocalTrack: client.clearPreparedLocalTrack.bind(client),
    getSnapshot: client.getSnapshot.bind(client),
    subscribe: client.subscribe.bind(client),
  };
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
    telemetry: input.telemetry,
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

function defaultSyncURL(apiBaseURL: string): string {
  const url = new URL(apiBaseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.hostname.startsWith("api.")) url.hostname = `sync.${url.hostname.slice(4)}`;
  url.pathname = "/v1/sync";
  url.search = "";
  url.hash = "";
  return url.toString();
}
