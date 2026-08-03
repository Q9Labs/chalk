import { CloudflareSFUClient, createCloudflareSFUHTTPTransport } from "../media";
import { createChalkChatFileHttpTransport } from "../chat-files";
import { createV1SyncClient } from "../sync";
import { createChalkWhiteboardV1Client, createChalkWhiteboardV1FileHttpTransport } from "../whiteboard";
import type { ChalkSessionChatFileFactoryInput, ChalkSessionDependencies, ChalkSessionMediaFactoryInput, ChalkSessionSyncFactoryInput, ChalkSessionWhiteboardFactoryInput } from "./dependencies";
import { createBrowserMediaDevices } from "./media-devices";

export function createDefaultChalkSessionDependencies(options: { readonly apiBaseURL: string; readonly syncURL: string; readonly whiteboardURL?: string | null }): ChalkSessionDependencies {
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
  };
}

function createChatFileTransport(apiBaseURL: string, input: ChalkSessionChatFileFactoryInput) {
  return createChalkChatFileHttpTransport({
    baseUrl: apiBaseURL,
    token: input.token,
  });
}

function createMediaClient(apiBaseURL: string, input: ChalkSessionMediaFactoryInput): CloudflareSFUClient {
  const { subject } = input.access;
  return new CloudflareSFUClient({
    bootstrap: input.access.media.clientPayload,
    participantSessionId: subject.participantSessionId,
    transport: createCloudflareSFUHTTPTransport({
      apiBaseURL,
      credential: input.credential,
      tenantId: subject.tenantId,
      roomId: subject.roomId,
      sessionId: subject.sessionId,
      participantSessionId: subject.participantSessionId,
    }),
    onError: input.onFailure,
    onScreenEnded: input.onScreenEnded,
  });
}

function createSyncClient(syncURL: string, input: ChalkSessionSyncFactoryInput) {
  return createV1SyncClient({
    url: syncURL,
    token: input.token,
    mediaPlane: input.media,
    persistenceScope: `${input.access.subject.tenantId}:${input.access.subject.sessionId}:${input.access.subject.participantSessionId}`,
  });
}

function createWhiteboardClient(apiBaseURL: string, url: string, input: ChalkSessionWhiteboardFactoryInput) {
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
