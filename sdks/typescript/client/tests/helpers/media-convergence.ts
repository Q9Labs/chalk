import { expect, vi } from "vitest";
import type { ConnectionSyncClient } from "../../src/connection/dependencies";
import { V1SyncError } from "../../src/sync/v1-error";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../src/space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../../src/space-client/space-client";

export function mediaTrack(): MediaStreamTrack {
  return Object.assign(new EventTarget(), {
    contentHint: "",
    enabled: true,
    id: "track-1",
    kind: "audio",
    label: "",
    muted: false,
    readyState: "live" as const,
    onended: null,
    onmute: null,
    onunmute: null,
    applyConstraints: async () => undefined,
    clone: mediaTrack,
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop: () => undefined,
  });
}

export function capturedClient(
  platform: ReturnType<typeof createCoreTestPlatform>,
  track: MediaStreamTrack,
  overrides: { readonly mediaDevices?: Partial<NonNullable<typeof platform.dependencies.mediaDevices>>; readonly media?: Partial<ReturnType<typeof platform.dependencies.createMediaClient>>; readonly sync?: Partial<ConnectionSyncClient> } = {},
): ReturnType<typeof createSpaceClientForPlatform> {
  return createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia: async () => mediaStream(track), ...overrides.mediaDevices },
        createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), ...overrides.media }),
        createSyncClient: () => ({ ...platform.sync, ...overrides.sync }),
      },
    },
  );
}

export function mediaStream(track: MediaStreamTrack): MediaStream {
  return Object.assign(new EventTarget(), {
    active: true,
    id: "stream-1",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: () => undefined,
    removeTrack: () => undefined,
    clone: () => mediaStream(track),
    getTracks: () => [track],
    getAudioTracks: () => (track.kind === "audio" ? [track] : []),
    getVideoTracks: () => (track.kind === "video" ? [track] : []),
    getTrackById: (id: string) => (id === track.id ? track : null),
  });
}

export function createConvergenceScenario(source: "microphone" | "camera" | "screen", overrides: Parameters<typeof capturedClient>[2] = {}) {
  const platform = createCoreTestPlatform();
  const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video", stop: vi.fn() });
  const capture = vi.fn(async () => mediaStream(track));
  const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>(async () => {
    if (platform.sync.getSnapshot().connection.phase !== "live") throw new V1SyncError("Sync is recovering", "not_live");
    return { operationId: "target", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
  });
  const client = capturedClient(platform, track, {
    ...overrides,
    mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, ...overrides.mediaDevices },
    sync: { setMicrophoneEnabled: command, setCameraEnabled: command, setScreenShareEnabled: command, ...overrides.sync },
  });
  const setEnabled = source === "microphone" ? client.media.setMicrophoneEnabled : source === "camera" ? client.media.setCameraEnabled : client.media.setScreenShareEnabled;
  return { platform, track, capture, command, client, setEnabled };
}

export async function enterRecovery({ platform, client }: Pick<ReturnType<typeof createConvergenceScenario>, "platform" | "client">) {
  platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
  await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
}
