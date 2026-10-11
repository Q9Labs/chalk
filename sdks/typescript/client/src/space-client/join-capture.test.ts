import { describe, expect, it, vi } from "vitest";
import { createBrowserMediaDevices } from "../connection/media-devices";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import type { ClientFailure } from "./types";

describe("join with unavailable capture devices", () => {
  it("preserves devices switched off before leaving when rejoining with defaults", async () => {
    const platform = createCoreTestPlatform();
    const getUserMedia = vi.fn(async () => stream([track("audio"), track("video")]));
    const target = async () => ({ operationId: "toggle", name: "set_microphone_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia }, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: target, setCameraEnabled: target }) } },
    );
    try {
      await client.join();
      await client.media.setMicrophoneEnabled(false);
      await client.media.setCameraEnabled(false);
      await client.leave();
      getUserMedia.mockClear();
      await client.join();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
      expect(client.getSnapshot().media.local.camera.state).toBe("disabled");
    } finally {
      client.dispose();
    }
  });

  it.each([
    { name: "no camera", audioError: null, videoError: "NotFoundError", code: "media.device_not_found", microphone: true, camera: false },
    { name: "no microphone", audioError: "NotFoundError", videoError: null, code: "media.device_not_found", microphone: false, camera: true },
    { name: "no devices", audioError: "NotFoundError", videoError: "NotFoundError", code: "media.device_not_found", microphone: false, camera: false },
    { name: "busy camera", audioError: null, videoError: "NotReadableError", code: "media.device_busy", microphone: true, camera: false },
    { name: "camera permission denied", audioError: null, videoError: "NotAllowedError", code: "media.permission_denied", microphone: true, camera: false },
    { name: "both permissions denied", audioError: "NotAllowedError", videoError: "NotAllowedError", code: "media.permission_denied", microphone: false, camera: false },
    { name: "invalid camera constraint", audioError: null, videoError: "OverconstrainedError", code: "media.device_constraint_invalid", microphone: true, camera: false },
    { name: "other camera failure", audioError: null, videoError: "AbortError", code: "media.capture_failed", microphone: true, camera: false },
    { name: "unsupported camera device", audioError: null, videoError: "NotSupportedError", code: "media.capture_failed", microphone: true, camera: false },
    { name: "refused camera device", audioError: null, videoError: "SecurityError", code: "media.capture_failed", microphone: true, camera: false },
  ])("enters with working devices and one recoverable error: $name", async ({ audioError, videoError, code, microphone, camera }) => {
    const platform = createCoreTestPlatform();
    const audio = track("audio");
    const video = track("video");
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio && audioError) throw new DOMException("Audio capture failed", audioError);
      if (constraints.video && videoError) throw new DOMException("Video capture failed", videoError);
      return stream([...(constraints.audio ? [audio] : []), ...(constraints.video ? [video] : [])]);
    });
    const start = vi.fn(async (_stream: MediaStream) => undefined);
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }) } },
    );
    const errors: ClientFailure[] = [];
    client.on("error", ({ error }) => errors.push(error));
    try {
      await client.join();
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code, recoverable: true });
      expect(errors[0]?.message).toContain(microphone ? "Camera" : camera ? "Microphone" : "Microphone and camera");
      expect(client.getSnapshot().media.local.microphone.state).toBe(microphone ? "requesting" : "disabled");
      expect(client.getSnapshot().media.local.camera.state).toBe(camera ? "requesting" : "disabled");
      expect(start.mock.calls).toHaveLength(1);
      expect(start.mock.calls[0]?.[0]?.getTracks()).toEqual([...(microphone ? [audio] : []), ...(camera ? [video] : [])]);
      if (microphone) expect(audio.stop).not.toHaveBeenCalled();
      if (camera) expect(video.stop).not.toHaveBeenCalled();
      await client.leave();
      expect(errors).toHaveLength(1);
      if (microphone) expect(audio.stop).toHaveBeenCalled();
      if (camera) expect(video.stop).toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("keeps a single capture request when both devices work", async () => {
    const platform = createCoreTestPlatform();
    const getUserMedia = vi.fn(async () => stream([track("audio"), track("video")]));
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia } } });
    const error = vi.fn();
    client.on("error", error);
    try {
      await client.join();
      expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: true });
      expect(error).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("recovers when a camera that worked in the entrance fails during join", async () => {
    const platform = createCoreTestPlatform();
    let preview = true;
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (!preview && constraints.video) throw new DOMException("Camera became busy", "NotReadableError");
      return stream([...(constraints.audio ? [track("audio")] : []), ...(constraints.video ? [track("video")] : [])]);
    });
    const previewStream = await getUserMedia({ audio: true, video: true });
    previewStream.getTracks().forEach((input) => input.stop());
    preview = false;
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia } } });
    try {
      await client.join();
      expect(client.getSnapshot().connection).toMatchObject({ status: "live", lastError: { code: "media.device_busy", recoverable: true } });
      expect(client.getSnapshot().media.local.camera.state).toBe("disabled");
      expect(client.getSnapshot().media.local.microphone.track?.kind).toBe("audio");
    } finally {
      client.dispose();
    }
  });

  it("still rejects an environment with no capture API", async () => {
    const platform = createCoreTestPlatform();
    const getAccess = vi.fn(async () => opaqueAccessGrant("test"));
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: createBrowserMediaDevices(undefined) } });
    try {
      await expect(client.join()).rejects.toThrow(/media capture is unavailable/i);
      expect(client.getSnapshot().connection).toMatchObject({ status: "failed", lastError: { code: "environment.unsupported", recoverable: false } });
      expect(getAccess).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });
});

function track(kind: "audio" | "video"): MediaStreamTrack {
  return Object.assign(new EventTarget(), {
    contentHint: "",
    enabled: true,
    id: kind,
    kind,
    label: "",
    muted: false,
    readyState: "live" as const,
    onended: null,
    onmute: null,
    onunmute: null,
    applyConstraints: async () => undefined,
    clone: () => track(kind),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop: vi.fn(),
  });
}

function stream(tracks: readonly MediaStreamTrack[]): MediaStream {
  return Object.assign(new EventTarget(), {
    active: true,
    id: "capture",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: () => undefined,
    removeTrack: () => undefined,
    clone: () => stream(tracks),
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((input) => input.kind === "audio"),
    getVideoTracks: () => tracks.filter((input) => input.kind === "video"),
    getTrackById: (id: string) => tracks.find((input) => input.id === id) ?? null,
  });
}
