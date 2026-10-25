import type { V1MediaPause } from "../sync/v1-types";
import type { AccessGrant } from "./index";
import type { ConnectionDependencies, ConnectionMediaClient, ConnectionSyncClient } from "../connection/dependencies";
import type { SpaceClientPlatform } from "./core";
export type CoreTestMediaSnapshot = ReturnType<ConnectionMediaClient["getSnapshot"]>;
export type CoreTestPlatform = SpaceClientPlatform & {
  readonly dependencies: Pick<ConnectionDependencies, "clock" | "mediaDevices" | "createMediaClient" | "createSyncClient" | "cancelPendingAdmission">;
  readonly media: {
    readonly getSnapshot: () => CoreTestMediaSnapshot;
    readonly emit: (snapshot: CoreTestMediaSnapshot) => void;
  };
  readonly sync: ConnectionSyncClient;
  readonly emitMediaPause: (pause: V1MediaPause) => void;
  readonly emitSync: (snapshot: ReturnType<ConnectionSyncClient["getSnapshot"]>) => void;
};
export function createCoreTestPlatform(participantId = "participant-1"): CoreTestPlatform {
  let mediaSnapshot: CoreTestMediaSnapshot = {
    connection: { phase: "idle", peerConnectionState: null, iceConnectionState: null },
    cursor: null,
    localTracks: [],
    remoteTracks: [],
    failure: null,
  } as CoreTestMediaSnapshot;
  let syncSnapshot: ReturnType<ConnectionSyncClient["getSnapshot"]> = {
    connection: { phase: "idle" },
    participantId: null,
    participantGeneration: null,
    control: null,
    optimisticControl: null,
    media: null,
    presence: null,
    mediaPlane: { local: [], remote: [] },
    localMedia: { microphone: "unknown", camera: "unknown", screen: "unknown" },
    pendingCommandCount: 0,
  };
  const mediaListeners = new Set<() => void>();
  const syncListeners = new Set<(snapshot: typeof syncSnapshot) => void>();
  const media: ConnectionMediaClient = {
    start: async () => {
      mediaSnapshot = { ...mediaSnapshot, connection: { ...mediaSnapshot.connection, phase: "live" } };
      for (const listener of mediaListeners) listener();
    },
    stop: () => undefined,
    restart: async () => undefined,
    prepareLocalTrack: () => undefined,
    clearPreparedLocalTrack: async () => undefined,
    setLocalPublicationTarget: async () => ({ outcome: "confirmed", errorCode: null }),
    observeLocalPublications: () => () => undefined,
    observeRemotePublications: () => () => undefined,
    getSnapshot: () => mediaSnapshot,
    subscribe: (listener: () => void) => {
      mediaListeners.add(listener);
      return () => mediaListeners.delete(listener);
    },
  } as unknown as ConnectionMediaClient;
  const pauseListeners = new Set<(pause: V1MediaPause) => void>();
  const sync: ConnectionSyncClient = {
    start: async () => {
      syncSnapshot = { ...syncSnapshot, connection: { phase: "live" }, participantId, participantGeneration: 1 };
      for (const listener of syncListeners) listener(syncSnapshot);
    },
    confirmEntered: async () => undefined,
    stop: () => undefined,
    leave: async () => ({ type: "ack", command_id: "command-1", outcome: "satisfied", revision: 1, state_digest: "digest" }),
    getSnapshot: () => syncSnapshot,
    subscribe: (listener: (snapshot: typeof syncSnapshot) => void) => {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    subscribeCollaboration: () => () => undefined,
    getCollaborationExtensionState: () => ({ version: 1, chatHeadSequence: null }),
    getParticipantCollaborationCapabilities: () => ({}),
    onMediaPause: (listener: (pause: V1MediaPause) => void) => {
      pauseListeners.add(listener);
      return () => pauseListeners.delete(listener);
    },
    onDirectedRequest: () => () => undefined,
  } as unknown as ConnectionSyncClient;
  return {
    whiteboardUrl: null,
    dependencies: {
      cancelPendingAdmission: async () => true,
      clock: { now: () => Date.now(), setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>) },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream, getDisplayMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream, enumerateDevices: async () => [] },
      createMediaClient: () => media,
      createSyncClient: () => sync,
    },
    media: {
      getSnapshot: () => mediaSnapshot,
      emit: (snapshot) => {
        mediaSnapshot = snapshot;
        for (const listener of mediaListeners) listener();
      },
    },
    sync,
    emitMediaPause: (pause) => {
      for (const listener of pauseListeners) listener(pause);
    },
    emitSync: (snapshot) => {
      syncSnapshot = snapshot;
      for (const listener of syncListeners) listener(syncSnapshot);
    },
  };
}
export function opaqueAccessGrant(value: string | number, suffix = String(value), connectionId = "connection-1"): AccessGrant {
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  return {
    subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 1 },
    sync: { token: credential("chalk-sync", suffix), expires_at: expiresAt },
    media: { token: credential("chalk-media", suffix), expires_at: expiresAt, provider: "cloudflare_sfu", client_payload: { connectionId, stunServer: "stun:stun.cloudflare.com:3478" } },
  } as unknown as AccessGrant;
}
function credential(audience: "chalk-sync" | "chalk-media", suffix: string): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.${suffix}`;
}
