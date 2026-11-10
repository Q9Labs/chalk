import {
  AsyncStorageV1PendingTargetStore,
  CloudflareSFUClient,
  createChalkChatFileHttpTransport,
  createChalkWhiteboardV1Client,
  createChalkWhiteboardV1FileDownloadTransport,
  createDirectFirstWebSocketFactory,
  createCloudflareSFUHTTPTransport,
  createReactNativeSyncLifecycle,
  createReactNativeWebSocketFactory,
  createV1SyncClient,
  mediaBootstrap,
  setSessionSource,
  type GetAccess,
  type ReactNativeWebSocketConstructor,
  type ReactNativeAsyncStorage,
} from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform, defaultSyncUrl, type SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import type { SpaceClient } from "@q9labsai/chalk-client";
import { RTCPeerConnection, mediaDevices } from "@cloudflare/react-native-webrtc";
import { AppState } from "react-native";
import { toNativeCaptureError } from "../media/native-capture-error";
import { createNativeSession, type NativeSession } from "./native-session";
import { ensureRandomUUID } from "./random-uuid";
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
  /** Direct Sync URL tried before `syncUrl`, with fallback. Unset (the default) keeps today's single path. */
  readonly syncDirectUrl?: string;
  readonly whiteboardURL?: string | null;
  readonly microphone?: boolean;
  readonly camera?: boolean;
  readonly syncStartupTimeoutMs?: number;
  readonly storage?: ReactNativeAsyncStorage;
};
let installedSession: NativeSession | undefined;
/** Starts the app's session and attaches it to every Chalk request; call once at launch. Later calls return the same session. */
export function installNativeSession(): NativeSession {
  if (installedSession) return installedSession;
  ensureRandomUUID();
  installedSession = createNativeSession({ appState: AppState, now: () => Date.now() });
  setSessionSource(installedSession.current);
  return installedSession;
}
export function createNativeSpaceClient(options: NativeSpaceClientOptions): SpaceClient {
  const session = installNativeSession();
  const { storage } = options;
  const syncDialTimeoutMs = options.syncStartupTimeoutMs ?? 30000;
  const apiBaseURL = options.baseUrl ?? "https://api.chalkmeet.com";
  const syncURL = options.syncUrl ?? defaultSyncUrl(apiBaseURL);
  const fetch = globalThis.fetch;
  const lifecycle = createReactNativeSyncLifecycle({ appState: AppState });
  const webSocket = createReactNativeWebSocketFactory(globalThis.WebSocket as unknown as ReactNativeWebSocketConstructor);
  const syncWebSocket = options.syncDirectUrl ? createDirectFirstWebSocketFactory({ directUrl: options.syncDirectUrl, inner: webSocket }) : webSocket;
  const dependencies: PlatformDependencies = {
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    },
    mediaDevices: {
      getUserMedia: async (constraints) => {
        try {
          return (await mediaDevices.getUserMedia(constraints)) as unknown as globalThis.MediaStream;
        } catch (cause) {
          throw toNativeCaptureError(cause);
        }
      },
      getDisplayMedia: async () => (await mediaDevices.getDisplayMedia()) as unknown as globalThis.MediaStream,
    },
    createMediaClient: (input) => createMediaClient(apiBaseURL, input, fetch),
    createSyncClient: (input) => createSyncClient(syncURL, input, lifecycle, syncWebSocket, storage, syncDialTimeoutMs),
    createChatFileTransport: (input) => createChatFileTransport(apiBaseURL, input, fetch),
    createWhiteboardClient: options.whiteboardURL === null ? undefined : (input) => createWhiteboardClient(apiBaseURL, options.whiteboardURL ?? whiteboardURL(syncURL), input, fetch, lifecycle, webSocket, syncDialTimeoutMs),
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
      // Keep the 30s native dial allowance, plus time for its replacement.
      syncStartupTimeoutMs: options.syncStartupTimeoutMs ?? 60000,
      initialMicrophoneEnabled: options.microphone,
      initialCameraEnabled: options.camera,
    },
  );
  client.subscribe(() => session.setCallOpen(client, CALL_OPEN_STATUSES.has(client.getSnapshot().connection.status)));
  // A disposed client stops publishing, so a dispose without leave() must clear the open-call mark itself.
  const disposeClient = client.dispose;
  return Object.assign(client, {
    dispose: () => {
      disposeClient.call(client);
      session.setCallOpen(client, false);
    },
  });
}
const CALL_OPEN_STATUSES: ReadonlySet<string> = new Set(["joining", "live", "reconnecting", "leaving"]);
function createMediaClient(apiBaseURL: string, input: MediaFactoryInput, fetch: typeof globalThis.fetch): NativeMediaClient {
  const { subject } = input.access;
  const replaceMediaConnection = input.replaceMediaConnection;
  const bootstrap = mediaBootstrap(input.access.media);
  const client = new CloudflareSFUClient({
    bootstrap,
    participantId: subject.participantId,
    transport: createCloudflareSFUHTTPTransport({
      apiBaseURL,
      credential: input.credential,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      episodeId: subject.episodeId,
      participantId: subject.participantId,
      // The grant decides, so an older API without the capability keeps the per-operation routes.
      unifiedSignaling: bootstrap.capabilities?.unifiedSignaling === true,
      fetch,
    }),
    replaceMediaConnection: replaceMediaConnection ? async () => mediaBootstrap(await replaceMediaConnection()) : undefined,
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
    prepareLocalPublicationTarget: client.prepareLocalPublicationTarget.bind(client),
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
    start: client.start.bind(client),
    stop: client.stop.bind(client),
    restart: (input) => client.restart("provider" in input ? mediaBootstrap(input) : input),
    prepareLocalTrack: client.prepareLocalTrack.bind(client),
    clearPreparedLocalTrack: client.clearPreparedLocalTrack.bind(client),
    getSnapshot: client.getSnapshot.bind(client),
    subscribe: client.subscribe.bind(client),
  };
}
function createSyncClient(syncURL: string, input: SyncFactoryInput, lifecycle: ReturnType<typeof createReactNativeSyncLifecycle>, webSocket: ReturnType<typeof createReactNativeWebSocketFactory>, storage: ReactNativeAsyncStorage | undefined, dialTimeoutMs: number) {
  const subject = input.access.subject;
  const scope = `${subject.tenantId}:${subject.episodeId}:${subject.participantId}`;
  return createV1SyncClient({
    url: syncURL,
    token: input.token,
    mediaPlane: input.media,
    lifecycle,
    webSocket,
    dialTimeoutMs,
    entryConfirmation: true,
    ...(storage ? { pendingStore: new AsyncStorageV1PendingTargetStore({ scope, storage }) } : {}),
  });
}
function createChatFileTransport(apiBaseURL: string, input: ChatFileFactoryInput, fetch: typeof globalThis.fetch) {
  return createChalkChatFileHttpTransport({ baseUrl: apiBaseURL, token: input.token, fetch });
}
function createWhiteboardClient(apiBaseURL: string, url: string, input: WhiteboardFactoryInput, fetch: typeof globalThis.fetch, lifecycle: ReturnType<typeof createReactNativeSyncLifecycle>, webSocket: ReturnType<typeof createReactNativeWebSocketFactory>, dialTimeoutMs: number) {
  const files = createChalkWhiteboardV1FileDownloadTransport({
    baseUrl: apiBaseURL,
    token: input.token,
    fetch,
  });
  return createChalkWhiteboardV1Client({
    url,
    token: input.token,
    files,
    lifecycle,
    webSocket,
    dialTimeoutMs,
    onWatchdogReplacement: input.onWatchdogReplacement,
    onSummary: (summary) => {
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
