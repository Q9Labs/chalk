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
  type GetAccess,
  type ReactNativeWebSocketConstructor,
  type ReactNativeAsyncStorage,
} from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform, type SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import type { SpaceClient } from "@q9labsai/chalk-client";
import { RTCPeerConnection, mediaDevices } from "@cloudflare/react-native-webrtc";
import { AppState } from "react-native";
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
};
export function createNativeSpaceClient(options: NativeSpaceClientOptions): SpaceClient {
  const { storage } = options;
  const apiBaseURL = options.baseUrl ?? "https://api.chalkmeet.com";
  const syncURL = options.syncUrl ?? defaultSyncURL(apiBaseURL);
  const fetch = globalThis.fetch;
  const lifecycle = createReactNativeSyncLifecycle({ appState: AppState });
  const webSocket = createReactNativeWebSocketFactory(globalThis.WebSocket as unknown as ReactNativeWebSocketConstructor);
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
    createMediaClient: (input) => createMediaClient(apiBaseURL, input, fetch),
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
      dependencies,
      fetch,
      syncStartupTimeoutMs: options.syncStartupTimeoutMs ?? 30000,
      initialMicrophoneEnabled: options.microphone,
      initialCameraEnabled: options.camera,
    },
  );
  return client;
}
function createMediaClient(apiBaseURL: string, input: MediaFactoryInput, fetch: typeof globalThis.fetch): NativeMediaClient {
  const { subject } = input.access;
  const replaceMediaConnection = input.replaceMediaConnection;
  const client = new CloudflareSFUClient({
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
    replaceMediaConnection: replaceMediaConnection
      ? async () => {
          const replacement = await replaceMediaConnection();
          if (replacement.provider !== "cloudflare_sfu") throw new TypeError("The Cloudflare SFU adapter requires a Cloudflare SFU access grant");
          return replacement.clientPayload;
        }
      : undefined,
    peerConnectionFactory: (configuration) => {
      const connection = new RTCPeerConnection(configuration);
      return connection as unknown as globalThis.RTCPeerConnection;
    },
    onError: input.onFailure,
    onScreenEnded: input.onScreenEnded,
  });
  return createSFUConnectionMediaClient(client);
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
    onWatchdogReplacement: input.onWatchdogReplacement,
    onSummary: (summary) => {
      sceneId = summary.sceneId;
      input.onSummary(summary);
    },
  });
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
