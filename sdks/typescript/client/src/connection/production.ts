import { EpisodeStatusError, retryAfterMilliseconds } from "./episode-status";
import { ConnectionReporter } from "./report";
import { CloudflareSFUClient, createCloudflareSFUHTTPTransport } from "../media";
import { createChalkChatFileHttpTransport } from "../chat-files";
import { createBrowserWebSocketFactory, createV1SyncClient, defaultClock, directFirstSyncOptions } from "../sync";
import { createChalkWhiteboardV1Client, createChalkWhiteboardV1FileDownloadTransport } from "../whiteboard";
import { makeConnectionPlatformLayer, type ConnectionChatFileFactoryInput, type ConnectionDependencies, type ConnectionMediaFactoryInput, type ConnectionMediaClient, type ConnectionSyncFactoryInput, type ConnectionWhiteboardFactoryInput } from "./dependencies";
import { createBrowserMediaDevices } from "./media-devices";
import { withRequestContext } from "../session";
import { mediaBootstrap } from "../access/media-bootstrap";
import { directOrigin, type DirectPathMode } from "../direct-path";
import * as apiUrls from "../api-urls";
import { directSyncUrl, whiteboardUrl } from "../urls";
const apiFetch = withRequestContext();
export function createDefaultConnectionDependencies(options: { readonly apiBaseURL: string; readonly syncURL: string; readonly syncDirectURL?: string | null; readonly directPath?: DirectPathMode; readonly whiteboardURL?: string | null }): ConnectionDependencies {
  return {
    clock: defaultClock,
    createConnectionReporter: (access) => {
      const random = globalThis.crypto;
      if (!random?.randomUUID) return undefined;
      return new ConnectionReporter({
        traceparent: `00-${random.randomUUID().replaceAll("-", "")}-${random.randomUUID().replaceAll("-", "").slice(0, 16)}-01`,
        now: () => performance.now(),
        access,
        online: () => globalThis.navigator?.onLine !== false,
        subscribeOnline: (listener) => {
          globalThis.window?.addEventListener("online", listener);
          return () => globalThis.window?.removeEventListener("online", listener);
        },
        send: async (grant, report, signal, traceparent) => {
          const response = await apiFetch(apiUrls.connectionReports(options.apiBaseURL, grant.subject.tenantId), {
            method: "POST",
            headers: { Authorization: `Bearer ${grant.media.token}`, "Content-Type": "application/json", traceparent },
            body: JSON.stringify(report),
            signal,
            keepalive: true,
            credentials: "omit",
          });
          // A response (including rejection) is final; retry only transport failures.
          await response.body?.cancel();
        },
      });
    },
    mediaDevices: createBrowserMediaDevices(),
    getEpisodeStatus: async (access, signal) => {
      const response = await apiFetch(apiUrls.episodeStatus(options.apiBaseURL, access.subject), {
        headers: { Authorization: `Bearer ${access.media.token}` },
        signal,
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) throw new EpisodeStatusError(response.status, retryAfterMilliseconds(response.headers.get("Retry-After"), Date.now()));
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "status" in body && (body.status === "active" || body.status === "ending" || body.status === "ended")) return body.status;
      throw new TypeError("Invalid Episode status");
    },
    cancelPendingAdmission: async (access, signal) => {
      const response = await apiFetch(apiUrls.cancelJoin(options.apiBaseURL, access.subject), {
        method: "POST",
        headers: { Authorization: `Bearer ${access.media.token}` },
        signal,
      });
      if (!response.ok) throw new Error(`Admission cancellation failed with HTTP ${response.status}`);
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null && "cancelled" in body && body.cancelled === true;
    },
    createMediaClient: (input) => createMediaClient(options.apiBaseURL, options.directPath ?? "auto", input),
    createSyncClient: (input) => createSyncClient(options.syncURL, options.syncDirectURL, options.directPath ?? "auto", input),
    createChatFileTransport: (input) => createChatFileTransport(options.apiBaseURL, input),
    createWhiteboardClient: options.whiteboardURL === null ? undefined : (input) => createWhiteboardClient(options.apiBaseURL, options.whiteboardURL ?? whiteboardUrl(options.syncURL), input),
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
function createMediaClient(apiBaseURL: string, directPath: DirectPathMode, input: ConnectionMediaFactoryInput): ConnectionMediaClient {
  const { subject } = input.access;
  const replaceMediaConnection = input.replaceMediaConnection;
  const bootstrap = mediaBootstrap(input.access.media);
  const client = new CloudflareSFUClient({
    bootstrap,
    participantId: subject.participantId,
    replaceMediaConnection: replaceMediaConnection ? async (observedConnectionId) => mediaBootstrap(await replaceMediaConnection(observedConnectionId)) : undefined,
    transport: createCloudflareSFUHTTPTransport({
      apiBaseURL,
      credential: input.credential,
      ...(input.refreshCredential ? { refreshCredential: input.refreshCredential } : {}),
      onDiagnostic: input.onTransportDiagnostic,
      traceparent: input.traceparent,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      episodeId: subject.episodeId,
      participantId: subject.participantId,
      // The grant decides, so an older API without the capability keeps the per-operation routes.
      unifiedSignaling: bootstrap.capabilities?.unifiedSignaling === true,
      // The grant advertises the direct door; the Tunnel (apiBaseURL) stays the fallback, and `off` keeps every call on it.
      ...(directPath === "auto" && bootstrap.capabilities?.directSignalingUrl ? { directBaseURL: bootstrap.capabilities.directSignalingUrl } : {}),
      ...(input.onTransportPath ? { onPath: input.onTransportPath } : {}),
    }),
    onError: input.onFailure,
    // A pending local offer is a bug signal, not a failure. Log it so the next rig run names the call that started it.
    onDiagnostic: (event) => console.warn("chalk.media.local_offer_pending", event),
    onReceiveHealth: input.onTransportDiagnostic,
    onScreenEnded: input.onScreenEnded,
  });
  return createSFUConnectionMediaClient(client);
}
function createSFUConnectionMediaClient(client: CloudflareSFUClient): ConnectionMediaClient {
  return bindConnectionMediaClient(client, (input) => client.restart("provider" in input ? mediaBootstrap(input) : input));
}
type BoundMediaClient = Pick<
  ConnectionMediaClient,
  | "setLocalPublicationTarget"
  | "pauseLocalCapture"
  | "setLocalSourceIntent"
  | "closeForcedLocalPublication"
  | "observeLocalPublications"
  | "observeRemotePublications"
  | "observeAudioElement"
  | "remotePublicationsChanged"
  | "remoteParticipantsChanged"
  | "remotePublicationResumed"
  | "localPublicationWithdrawn"
  | "start"
  | "stop"
  | "prepareLocalTrack"
  | "clearPreparedLocalTrack"
  | "getSnapshot"
  | "subscribe"
> & { readonly prepareLocalPublicationTarget: NonNullable<ConnectionMediaClient["prepareLocalPublicationTarget"]> };
export function bindConnectionMediaClient(client: BoundMediaClient, restart: ConnectionMediaClient["restart"]): ConnectionMediaClient {
  return {
    prepareLocalPublicationTarget: client.prepareLocalPublicationTarget.bind(client),
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    ...(client.pauseLocalCapture ? { pauseLocalCapture: client.pauseLocalCapture.bind(client) } : {}),
    ...(client.setLocalSourceIntent ? { setLocalSourceIntent: client.setLocalSourceIntent.bind(client) } : {}),
    ...(client.closeForcedLocalPublication ? { closeForcedLocalPublication: client.closeForcedLocalPublication.bind(client) } : {}),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
    ...(client.observeAudioElement ? { observeAudioElement: client.observeAudioElement.bind(client) } : {}),
    ...(client.remoteParticipantsChanged ? { remoteParticipantsChanged: client.remoteParticipantsChanged.bind(client) } : {}),
    ...(client.remotePublicationsChanged ? { remotePublicationsChanged: client.remotePublicationsChanged.bind(client) } : {}),
    ...(client.remotePublicationResumed ? { remotePublicationResumed: client.remotePublicationResumed.bind(client) } : {}),
    ...(client.localPublicationWithdrawn ? { localPublicationWithdrawn: client.localPublicationWithdrawn.bind(client) } : {}),
    start: client.start.bind(client),
    stop: client.stop.bind(client),
    restart,
    prepareLocalTrack: client.prepareLocalTrack.bind(client),
    clearPreparedLocalTrack: client.clearPreparedLocalTrack.bind(client),
    getSnapshot: client.getSnapshot.bind(client),
    subscribe: client.subscribe.bind(client),
  };
}
function createSyncClient(syncURL: string, syncDirectURL: string | null | undefined, directPath: DirectPathMode, input: ConnectionSyncFactoryInput) {
  // A configured direct Sync URL wins, because the lobby warm socket was opened for it; otherwise the grant's door serves Sync too.
  const advertised = directOrigin(mediaBootstrap(input.access.media).capabilities?.directSignalingUrl);
  const directURL = directPath === "off" ? null : syncDirectURL || (advertised ? directSyncUrl(advertised) : null);
  if (!directURL) input.onTransportPath?.({ plane: "sync", path: "tunnel", fellBack: false });
  return createV1SyncClient({
    url: syncURL,
    onDiagnostic: input.onTransportDiagnostic,
    traceparent: input.traceparent,
    token: input.token,
    mediaPlane: input.media,
    collaboration: { name: "collaboration_v2", chatCursor: { afterSequence: null, retainedFloorSequence: null } },
    persistenceScope: `${input.access.subject.tenantId}:${input.access.subject.episodeId}:${input.access.subject.participantId}`,
    entryConfirmation: true,
    ...directFirstSyncOptions(directURL, createBrowserWebSocketFactory(), input.onTransportPath),
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
