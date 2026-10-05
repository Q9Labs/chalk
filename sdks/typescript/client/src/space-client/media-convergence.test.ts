import { describe, expect, it, vi } from "vitest";
import type { ConnectionSyncClient } from "../connection/dependencies";
import type { V1DirectedRequest } from "../sync/v1-types";
import { V1SyncError } from "../sync/v1-error";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("SpaceClient media convergence", () => {
  it("keeps durable off/on intents ordered while the early local pause is pending", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    let finishPause: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finishPause = resolve;
    });
    const target = vi.fn(async (input: { readonly enabled: boolean }) => {
      track.enabled = input.enabled;
      if (!input.enabled) await pending;
      return { outcome: "confirmed" as const, errorCode: null };
    });
    const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>().mockResolvedValue({ operationId: "toggle", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    const client = capturedClient(platform, track, { media: { setLocalPublicationTarget: target }, sync: { setMicrophoneEnabled: command } });
    try {
      await client.join({ microphone: true, camera: false });
      command.mockClear();
      const off = client.media.setMicrophoneEnabled(false);
      await vi.waitFor(() => expect(target).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
      const on = client.media.setMicrophoneEnabled(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const commandsBeforePause = command.mock.calls.length;
      finishPause();
      await Promise.all([off, on]);
      expect(commandsBeforePause).toBe(0);
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([false, true]);
      expect(target.mock.calls.filter(([input]) => !input.enabled)).toHaveLength(1);
    } finally {
      finishPause();
      client.dispose();
    }
  });

  it("pauses a local microphone before Sync confirms and restores it when Sync rejects", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    let rejectSync: (reason: Error) => void = () => undefined;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectSync = reject;
    });
    const target = vi.fn(async (input: { readonly enabled: boolean }) => {
      track.enabled = input.enabled;
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: input.enabled, publicationId: "publication-1", track }] });
      return { outcome: "confirmed" as const, errorCode: null };
    });
    const command = vi.fn(() => pending);
    const client = capturedClient(platform, track, { media: { setLocalPublicationTarget: target }, sync: { setMicrophoneEnabled: command } });
    try {
      await client.join({ microphone: true, camera: false });
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: true, publicationId: "publication-1", track }] });
      const muting = client.media.setMicrophoneEnabled(false);
      await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
      expect(track.enabled).toBe(false);
      expect(target.mock.calls[0]?.[0].enabled).toBe(false);
      rejectSync(new V1SyncError("Sync rejected the media change", "terminal_failure"));
      await expect(muting).rejects.toThrow("Sync rejected the media change");
      expect(track.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it.each([false, true])("applies forced off only to the old publication (fresh publication: %s)", async (fresh) => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const close = vi.fn(async () => {
      track.enabled = false;
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: false, publicationId: null, track }] });
    });
    const client = capturedClient(platform, track, { media: { closeForcedLocalPublication: close } });
    try {
      await client.join({ microphone: true, camera: false });
      const active = { participantId: "participant-1", source: "microphone" as const, enabled: true, publicationId: "old-publication" };
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 1, items: [active] } });
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: true, publicationId: fresh ? "fresh-publication" : active.publicationId, track }] });
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 2, items: [{ ...active, enabled: false, publicationId: null }] } });
      expect(close).toHaveBeenCalledTimes(fresh ? 0 : 1);
      expect(track.enabled).toBe(fresh);
      expect(client.getSnapshot().media.local.microphone.state).toBe(fresh ? "enabled" : "disabled");
    } finally {
      client.dispose();
    }
  });

  it("gates an attached remote track on the same projection as the muted state", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, platform);
    try {
      await client.join({ microphone: false, camera: false });
      const publication = { participantId: "participant-2", source: "microphone" as const, enabled: true, publicationId: "publication-2" };
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 1, items: [publication] } });
      platform.media.emit({ ...platform.media.getSnapshot(), remoteTracks: [{ ...publication, track }] });
      expect(track.enabled).toBe(true);
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 2, items: [{ ...publication, enabled: false }] } });
      expect(track.enabled).toBe(false);
      expect(client.getSnapshot().media.remote[0]?.track).toBe(track);
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 3, items: [publication] } });
      expect(track.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it.each(["accept", "decline", "expired"] as const)("requires target consent for an unmute request: %s", async (decision) => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const capture = vi.fn(async () => mediaStream(track));
    let receive = (_request: V1DirectedRequest): void => {
      throw new Error("Request listener is not bound");
    };
    const enable = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>(async () => {
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: true, publicationId: "publication-1", track }] });
      return { operationId: "unmute-1", name: "set_microphone_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" };
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { getUserMedia: capture },
          createSyncClient: () => ({
            ...platform.sync,
            setMicrophoneEnabled: enable,
            onDirectedRequest: (listener) => {
              receive = listener;
              return () => undefined;
            },
          }),
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      receive({ type: "directed_request", request_id: "request-1", name: "request_unmute", actor_participant_id: "requester-1", expires_at_ms: decision === "expired" ? 1 : Date.now() + 30_000 });
      expect(capture).not.toHaveBeenCalled();
      if (decision === "accept") {
        await client.media.acceptRequest("request-1");
        expect(capture).toHaveBeenCalledOnce();
        expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
      } else if (decision === "decline") {
        await client.media.declineRequest("request-1");
        expect(capture).not.toHaveBeenCalled();
      } else {
        await expect(client.media.acceptRequest("request-1")).rejects.toMatchObject({ code: "media.request_invalid" });
        expect(capture).not.toHaveBeenCalled();
      }
      expect(client.getSnapshot().media.incomingRequests).toHaveLength(0);
    } finally {
      client.dispose();
    }
  });

  it("sends an authoritative stop even when no local screen capture is retained", async () => {
    const platform = createCoreTestPlatform();
    const stop = vi.fn<ConnectionSyncClient["setScreenShareEnabled"]>().mockResolvedValue({ operationId: "stop-1", name: "set_screen_share_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: { ...platform.dependencies, createSyncClient: () => ({ ...platform.sync, setScreenShareEnabled: stop }) },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(false);
      expect(stop).toHaveBeenCalledWith(false);
      expect(client.getSnapshot().media.screenShare.state).toBe("disabled");
    } finally {
      client.dispose();
    }
  });

  it("shows a disabled provider publication as muted after moderation", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const client = capturedClient(platform, track);
    try {
      await client.join({ microphone: true, camera: false });
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: true, publicationId: "publication-1", track }] });
      expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: false, publicationId: null, track }] });
      expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
    } finally {
      client.dispose();
    }
  });

  it.each([
    ["NotFoundError", "media.device_not_found"],
    ["NotAllowedError", "media.permission_denied"],
    ["NotReadableError", "media.device_busy"],
    ["OverconstrainedError", "media.device_constraint_invalid"],
    ["NotSupportedError", "environment.unsupported"],
    ["AbortError", "media.capture_failed"],
  ])("preserves the recovery for %s at the public capture boundary", async (name, code) => {
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: {
            getUserMedia: async () => {
              throw new DOMException("capture failed", name);
            },
          },
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.media.setMicrophoneEnabled(true)).rejects.toMatchObject({ code });
    } finally {
      client.dispose();
    }
  });
});

function mediaTrack(): MediaStreamTrack {
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

function capturedClient(
  platform: ReturnType<typeof createCoreTestPlatform>,
  track: MediaStreamTrack,
  overrides: { readonly media?: Partial<ReturnType<typeof platform.dependencies.createMediaClient>>; readonly sync?: Partial<ConnectionSyncClient> } = {},
): ReturnType<typeof createSpaceClientForPlatform> {
  return createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia: async () => mediaStream(track) },
        createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), ...overrides.media }),
        createSyncClient: () => ({ ...platform.sync, ...overrides.sync }),
      },
    },
  );
}

function mediaStream(track: MediaStreamTrack): MediaStream {
  return Object.assign(new EventTarget(), {
    active: true,
    id: "stream-1",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: () => undefined,
    removeTrack: () => undefined,
    clone: () => mediaStream(track),
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    getTrackById: (id: string) => (id === track.id ? track : null),
  });
}
