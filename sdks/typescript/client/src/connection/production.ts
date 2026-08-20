import { CloudflareRTKClient, CloudflareSFUClient, createCloudflareSFUHTTPTransport } from "../media";
import { createChalkChatFileHttpTransport } from "../chat-files";
import { createV1SyncClient } from "../sync";
import { createChalkWhiteboardV1Client, createChalkWhiteboardV1FileHttpTransport } from "../whiteboard";
import { makeConnectionPlatformLayer, type ConnectionChatFileFactoryInput, type ConnectionDependencies, type ConnectionMediaFactoryInput, type ConnectionMediaClient, type ConnectionSyncFactoryInput, type ConnectionWhiteboardFactoryInput } from "./dependencies";
import { createBrowserMediaDevices } from "./media-devices";

export function createDefaultConnectionDependencies(options: { readonly apiBaseURL: string; readonly syncURL: string; readonly whiteboardURL?: string | null }): ConnectionDependencies {
  return {
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    },
    mediaDevices: createBrowserMediaDevices(),
    createMediaClient: (input) => createMediaClient(options.apiBaseURL, input),
    createSyncClient: (input) => createSyncClient(options.syncURL, input),
    createChatFileTransport: (input) => createChatFileTransport(options.apiBaseURL, input),
    createWhiteboardClient: options.whiteboardURL === null ? undefined : (input) => createWhiteboardClient(options.apiBaseURL, options.whiteboardURL ?? whiteboardURL(options.syncURL), input),
    subscribeForeground: subscribeBrowserForeground,
    createId: createBrowserId,
  };
}

/** Production foreign-adapter Layer. Tests replace it with makeFakeConnectionPlatformLayer. */
export const makeProductionConnectionPlatformLayer = (options: { readonly apiBaseURL: string; readonly syncURL: string; readonly whiteboardURL?: string | null }) => makeConnectionPlatformLayer(createDefaultConnectionDependencies(options));

function createBrowserId(): string {
  const random = globalThis.crypto;
  if (!random?.randomUUID) throw new TypeError("A secure browser identifier source is required");
  return random.randomUUID();
}

function subscribeBrowserForeground(listener: () => void): () => void {
  const documentTarget = globalThis.document;
  const windowTarget = globalThis.window;
  if (!documentTarget || !windowTarget) return () => undefined;
  const onVisibility = () => {
    if (documentTarget.visibilityState === "visible") listener();
  };
  documentTarget.addEventListener("visibilitychange", onVisibility);
  windowTarget.addEventListener("pageshow", listener);
  return () => {
    documentTarget.removeEventListener("visibilitychange", onVisibility);
    windowTarget.removeEventListener("pageshow", listener);
  };
}

function createChatFileTransport(apiBaseURL: string, input: ConnectionChatFileFactoryInput) {
  return createChalkChatFileHttpTransport({
    baseUrl: apiBaseURL,
    token: input.token,
  });
}

function createMediaClient(apiBaseURL: string, input: ConnectionMediaFactoryInput): ConnectionMediaClient {
  if (input.access.media.provider === "cloudflare_rtk") {
    return createRTKConnectionMediaClient(
      new CloudflareRTKClient({
        authToken: input.access.media.clientPayload.token,
        participantId: input.access.subject.participantId,
        onError: input.onFailure,
        onScreenEnded: input.onScreenEnded,
      }),
    );
  }
  const { subject } = input.access;
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
    }),
    onError: input.onFailure,
    onScreenEnded: input.onScreenEnded,
  });
  return createSFUConnectionMediaClient(client);
}

function createRTKConnectionMediaClient(client: CloudflareRTKClient): ConnectionMediaClient {
  return bindConnectionMediaClient(client, (input) => {
    if (!("provider" in input) || input.provider !== "cloudflare_rtk") throw new TypeError("The RealtimeKit adapter requires a Cloudflare RealtimeKit access grant");
    return client.restart(input);
  });
}

function createSFUConnectionMediaClient(client: CloudflareSFUClient): ConnectionMediaClient {
  return bindConnectionMediaClient(client, (input) => {
    if ("provider" in input) {
      if (input.provider !== "cloudflare_sfu") throw new TypeError("The Cloudflare SFU adapter requires a Cloudflare SFU access grant");
      return client.restart(input.clientPayload);
    }
    return client.restart(input);
  });
}

type BoundMediaClient = Pick<ConnectionMediaClient, "setLocalPublicationTarget" | "observeLocalPublications" | "observeRemotePublications" | "start" | "stop" | "prepareLocalTrack" | "clearPreparedLocalTrack" | "getSnapshot" | "subscribe">;

function bindConnectionMediaClient(client: BoundMediaClient, restart: ConnectionMediaClient["restart"]): ConnectionMediaClient {
  return {
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
    start: client.start.bind(client),
    stop: client.stop.bind(client),
    restart,
    prepareLocalTrack: client.prepareLocalTrack.bind(client),
    clearPreparedLocalTrack: client.clearPreparedLocalTrack.bind(client),
    getSnapshot: client.getSnapshot.bind(client),
    subscribe: client.subscribe.bind(client),
  };
}

function createSyncClient(syncURL: string, input: ConnectionSyncFactoryInput) {
  return createV1SyncClient({
    url: syncURL,
    token: input.token,
    mediaPlane: input.media,
    telemetry: input.telemetry,
    persistenceScope: `${input.access.subject.tenantId}:${input.access.subject.episodeId}:${input.access.subject.participantId}`,
  });
}

function createWhiteboardClient(apiBaseURL: string, url: string, input: ConnectionWhiteboardFactoryInput) {
  let sceneId: string | null = null;
  const files = createChalkWhiteboardV1FileHttpTransport({
    baseUrl: apiBaseURL,
    token: input.token,
    sceneId: () => {
      if (sceneId === null) throw new TypeError("Whiteboard scene is not ready");
      return sceneId;
    },
  });
  return createChalkWhiteboardV1Client({
    url,
    token: input.token,
    files,
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
