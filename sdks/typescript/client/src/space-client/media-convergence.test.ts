import { describe, expect, it, vi } from "vitest";
import type { ConnectionSyncClient } from "../connection/dependencies";
import type { V1DirectedRequest } from "../sync/v1-types";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("SpaceClient media convergence", () => {
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
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => mediaStream(track) } },
      },
    );
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
