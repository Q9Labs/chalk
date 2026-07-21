import { CloudflareSFUClient, createCloudflareSFUHTTPTransport } from "../media";
import { createV3SyncClient } from "../sync";
import type { ChalkSessionDependencies, ChalkSessionMediaFactoryInput, ChalkSessionSyncFactoryInput } from "./dependencies";
import { createBrowserMediaDevices } from "./media-devices";

export function createDefaultChalkSessionDependencies(options: { readonly apiBaseURL: string; readonly syncURL: string }): ChalkSessionDependencies {
  return {
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    },
    mediaDevices: createBrowserMediaDevices(),
    createMediaClient: (input) => createMediaClient(options.apiBaseURL, input),
    createSyncClient: (input) => createSyncClient(options.syncURL, input),
  };
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
  return createV3SyncClient({
    url: syncURL,
    token: input.token,
    mediaPlane: input.media,
    persistenceScope: `${input.access.subject.tenantId}:${input.access.subject.sessionId}:${input.access.subject.participantSessionId}`,
  });
}
