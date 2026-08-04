import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeSpaceClientCoreLayer, SpaceClientCoreService, type SpaceClientPlatform } from "./core";
import type { AccessGrant } from "./index";

type PlatformDependencies = NonNullable<SpaceClientPlatform["dependencies"]>;
type ConnectionMediaClient = ReturnType<NonNullable<PlatformDependencies["createMediaClient"]>>;
type ConnectionSyncClient = ReturnType<NonNullable<PlatformDependencies["createSyncClient"]>>;

describe("SpaceClientCore", () => {
  it("constructs as a scoped native service with an idle snapshot", async () => {
    const runtime = ManagedRuntime.make(
      makeSpaceClientCoreLayer({
        space: "demo",
        getAccess: async () => {
          throw new Error("not joined");
        },
      }),
    );
    const core = runtime.runSync(Effect.service(SpaceClientCoreService));

    expect(core.getSnapshot().connection.status).toBe("idle");
    await runtime.dispose();
  });

  it("prefers the platform connection-access bridge without widening public GetAccess", async () => {
    const connectionAccess = vi.fn<NonNullable<SpaceClientPlatform["connectionAccess"]>>(async () => opaqueAccessGrant("bridge"));
    const getAccess = vi.fn(async () => Promise.reject(new Error("The public access callback must not run")));
    const runtime = ManagedRuntime.make(makeSpaceClientCoreLayer({ space: "demo", getAccess }, platformWithConnectionAccess(connectionAccess)));
    const core = runtime.runSync(Effect.service(SpaceClientCoreService));

    await runtime.runPromise(core.join({ microphone: false, camera: false }));

    expect(connectionAccess).toHaveBeenCalledWith(expect.objectContaining({ reason: "join", replaceMediaConnection: false }));
    expect(getAccess).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("falls back to the public access context when no platform bridge is installed", async () => {
    const getAccess = vi.fn(async () => opaqueAccessGrant("public"));
    const runtime = ManagedRuntime.make(makeSpaceClientCoreLayer({ space: "demo", getAccess }, platformWithConnectionAccess()));
    const core = runtime.runSync(Effect.service(SpaceClientCoreService));

    await runtime.runPromise(core.join({ microphone: false, camera: false }));

    expect(getAccess).toHaveBeenCalledWith({ space: "demo", reason: "join" });
    await runtime.dispose();
  });
});

function platformWithConnectionAccess(connectionAccess?: NonNullable<SpaceClientPlatform["connectionAccess"]>): SpaceClientPlatform {
  let mediaSnapshot = { connection: { phase: "idle", peerConnectionState: null, iceConnectionState: null }, cursor: null, localTracks: [], remoteTracks: [], failure: null };
  let syncSnapshot = {
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
    getSnapshot: () => mediaSnapshot,
    subscribe: (listener) => {
      mediaListeners.add(listener);
      return () => mediaListeners.delete(listener);
    },
  } as unknown as ConnectionMediaClient;
  const sync: ConnectionSyncClient = {
    start: async () => {
      syncSnapshot = { ...syncSnapshot, connection: { phase: "live" }, participantId: "participant-1", participantGeneration: 1 };
      for (const listener of syncListeners) listener(syncSnapshot);
    },
    stop: () => undefined,
    leave: async () => ({ type: "ack", command_id: "command-1", outcome: "satisfied", revision: 1, state_digest: "digest" }),
    getSnapshot: () => syncSnapshot,
    subscribe: (listener) => {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    subscribeCollaboration: () => () => undefined,
    getCollaborationExtensionState: () => ({ version: 1, chatHeadSequence: null }),
    getParticipantCollaborationCapabilities: () => ({}),
    onDirectedRequest: () => () => undefined,
  } as unknown as ConnectionSyncClient;

  return {
    whiteboardUrl: null,
    ...(connectionAccess ? { connectionAccess } : {}),
    dependencies: {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream, getDisplayMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream, enumerateDevices: async () => [] },
      createMediaClient: () => media,
      createSyncClient: () => sync,
    },
  };
}

function opaqueAccessGrant(suffix: string): AccessGrant {
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  return {
    subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 1 },
    sync: { token: credential("chalk-sync", suffix), expires_at: expiresAt },
    media: { token: credential("chalk-media", suffix), expires_at: expiresAt, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:stun.cloudflare.com:3478" } },
  } as AccessGrant;
}

function credential(audience: "chalk-sync" | "chalk-media", suffix: string): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.${suffix}`;
}
