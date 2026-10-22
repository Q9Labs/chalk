import { CloudflareSFUClient, createCloudflareSFUHTTPTransport } from "../media";
import { createChalkChatFileHttpTransport } from "../chat-files";
import { createV1SyncClient } from "../sync";
import { createChalkWhiteboardV1Client, createChalkWhiteboardV1FileDownloadTransport } from "../whiteboard";
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
    cancelPendingAdmission: async (access, signal) => {
      const { tenantId, spaceId, episodeId, participantId } = access.subject;
      const path = [tenantId, spaceId, episodeId, participantId].map(encodeURIComponent);
      let baseEnd = options.apiBaseURL.length;
      while (baseEnd > 0 && options.apiBaseURL[baseEnd - 1] === "/") baseEnd--;
      const baseURL = options.apiBaseURL.slice(0, baseEnd);
      const response = await fetch(`${baseURL}/v1/tenants/${path[0]}/spaces/${path[1]}/episodes/${path[2]}/participants/${path[3]}/cancel-join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.media.token}` },
        signal,
      });
      if (!response.ok) throw new Error(`Admission cancellation failed with HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("cancelled" in body) || typeof body.cancelled !== "boolean") throw new Error("Admission cancellation returned an invalid outcome");
      return body.cancelled;
    },
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
  const { subject } = input.access;
  const replaceMediaConnection = input.replaceMediaConnection;
  const client = new CloudflareSFUClient({
    bootstrap: input.access.media.clientPayload,
    participantId: subject.participantId,
    replaceMediaConnection: replaceMediaConnection
      ? async () => {
          const replacement = await replaceMediaConnection();
          if (replacement.provider !== "cloudflare_sfu") throw new TypeError("The Cloudflare SFU adapter requires a Cloudflare SFU access grant");
          return replacement.clientPayload;
        }
      : undefined,
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
function createSFUConnectionMediaClient(client: CloudflareSFUClient): ConnectionMediaClient {
  return bindConnectionMediaClient(client, (input) => {
    if ("provider" in input) {
      if (input.provider !== "cloudflare_sfu") throw new TypeError("The Cloudflare SFU adapter requires a Cloudflare SFU access grant");
      return client.restart(input.clientPayload);
    }
    return client.restart(input);
  });
}
type BoundMediaClient = Pick<
  ConnectionMediaClient,
  | "setLocalPublicationTarget"
  | "setLocalSourceIntent"
  | "closeForcedLocalPublication"
  | "observeLocalPublications"
  | "observeRemotePublications"
  | "remotePublicationsChanged"
  | "remoteParticipantsChanged"
  | "remotePublicationResumed"
  | "start"
  | "stop"
  | "prepareLocalTrack"
  | "clearPreparedLocalTrack"
  | "getSnapshot"
  | "subscribe"
>;
export function bindConnectionMediaClient(client: BoundMediaClient, restart: ConnectionMediaClient["restart"]): ConnectionMediaClient {
  return {
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    ...(client.setLocalSourceIntent ? { setLocalSourceIntent: client.setLocalSourceIntent.bind(client) } : {}),
    ...(client.closeForcedLocalPublication ? { closeForcedLocalPublication: client.closeForcedLocalPublication.bind(client) } : {}),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
    ...(client.remoteParticipantsChanged ? { remoteParticipantsChanged: client.remoteParticipantsChanged.bind(client) } : {}),
    ...(client.remotePublicationsChanged ? { remotePublicationsChanged: client.remotePublicationsChanged.bind(client) } : {}),
    ...(client.remotePublicationResumed ? { remotePublicationResumed: client.remotePublicationResumed.bind(client) } : {}),
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
    collaboration: { name: "collaboration_v2", chatCursor: { afterSequence: null, retainedFloorSequence: null } },
    persistenceScope: `${input.access.subject.tenantId}:${input.access.subject.episodeId}:${input.access.subject.participantId}`,
  });
}
function createWhiteboardClient(apiBaseURL: string, url: string, input: ConnectionWhiteboardFactoryInput) {
  const files = createChalkWhiteboardV1FileDownloadTransport({
    baseUrl: apiBaseURL,
    token: input.token,
  });
  return createChalkWhiteboardV1Client({
    url,
    token: input.token,
    files,
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
