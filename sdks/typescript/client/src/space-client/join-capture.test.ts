import { noCaptureDevices, stream, track } from "./capture.test.helpers";
import { describe, expect, it, vi } from "vitest";
import { createBrowserMediaDevices } from "../connection/media-devices";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import type { ClientFailure } from "./types";
import { V1SyncError } from "../sync/v1-error";

describe("join with unavailable capture devices", () => {
  it("refreshes cameras after private preview permission without publishing or enabling the camera", async () => {
    const platform = createCoreTestPlatform();
    let permitted = false;
    const camera = (deviceId: string, label: string): MediaDeviceInfo => ({ deviceId, label, groupId: "cameras", kind: "videoinput", toJSON: () => ({ deviceId, label }) });
    const preview = track("video");
    const getUserMedia = vi.fn(async () => {
      permitted = true;
      return stream([preview]);
    });
    const start = vi.fn(async () => undefined);
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { getUserMedia, enumerateDevices: async () => (permitted ? [camera("one", "Front camera"), camera("two", "Back camera")] : [camera("", "")]) },
          createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }),
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await vi.waitFor(() => expect(client.getSnapshot().media.devices.cameras).toHaveLength(1));
      start.mockClear();
      const captured = await client.media.captureCameraPreview();
      expect(captured.track).toBe(preview);
      expect(client.getSnapshot().media.devices.cameras.map(({ label }) => label)).toEqual(["Front camera", "Back camera"]);
      expect(client.getSnapshot().media.local.camera).toMatchObject({ state: "disabled", track: null });
      expect(start).not.toHaveBeenCalled();
      expect(preview.stop).not.toHaveBeenCalled();
      captured.release();
    } finally {
      client.dispose();
    }
  });

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
    const start = vi.fn(async (stream: MediaStream) => {
      // The working device has a publication, but no authoritative Sync projection yet.
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: stream.getTracks().map((track) => ({ source: track.kind === "audio" ? ("microphone" as const) : ("camera" as const), enabled: true, publicationId: `working-${track.kind}`, track })) });
    });
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

describe("join with media on", () => {
  const joinWith = (setMicrophoneEnabled: ReturnType<typeof vi.fn>, setCameraEnabled: ReturnType<typeof vi.fn>, tracks = [track("audio"), track("video")]) => {
    const platform = createCoreTestPlatform();
    return createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { getUserMedia: async () => stream(tracks), enumerateDevices: async () => [] },
          createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled, setCameraEnabled }),
        },
      },
    );
  };

  // Chalk's own SFU forwards a source only under a grant, and Sync grants it only for an on it has accepted.
  it("asks Sync to turn on each source it published at join", async () => {
    const accepted = async () => ({ operationId: "on", name: "set_camera_enabled" as const, serverOutcome: "confirmed" as const, mediaPlaneOutcome: "confirmed" as const });
    const setMicrophoneEnabled = vi.fn(accepted);
    const setCameraEnabled = vi.fn(accepted);
    const client = joinWith(setMicrophoneEnabled, setCameraEnabled);
    try {
      await client.join({ microphone: true, camera: true });
      await vi.waitFor(() => {
        expect(setMicrophoneEnabled).toHaveBeenCalledWith(true);
        expect(setCameraEnabled).toHaveBeenCalledWith(true);
      });
    } finally {
      client.dispose();
    }
  });

  it("does not ask Sync to turn on a source joined off", async () => {
    const accepted = async () => ({ operationId: "on", name: "set_microphone_enabled" as const, serverOutcome: "confirmed" as const, mediaPlaneOutcome: "confirmed" as const });
    const setMicrophoneEnabled = vi.fn(accepted);
    const setCameraEnabled = vi.fn(accepted);
    const client = joinWith(setMicrophoneEnabled, setCameraEnabled);
    try {
      await client.join({ microphone: true, camera: false });
      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledWith(true));
      expect(setCameraEnabled).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("resends the on after a short disconnect loses it, and keeps the source on", async () => {
    const platform = createCoreTestPlatform();
    const microphone = track("audio");
    const accepted = { operationId: "on", name: "set_microphone_enabled" as const, serverOutcome: "confirmed" as const, mediaPlaneOutcome: "confirmed" as const };
    const setMicrophoneEnabled = vi.fn(async () => {
      if (setMicrophoneEnabled.mock.calls.length > 1) return accepted;
      throw new V1SyncError("disconnected_before_delivery", "disconnected_before_delivery");
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => stream([microphone]), enumerateDevices: async () => [] }, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled }) } },
    );
    try {
      await client.join({ microphone: true, camera: false });
      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledTimes(1));
      const live = platform.sync.getSnapshot();
      const media = { projectionId: "sync", sequence: 1, items: [{ participantId: "participant-1", source: "microphone" as const, enabled: true, publicationId: "microphone-1" }] };
      platform.emitSync({ ...live, connection: { phase: "reconnecting" } });
      platform.emitSync({ ...live, media });
      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledTimes(2));
      expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
      expect(microphone.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("keeps consent when the call is left before Sync answers the on", async () => {
    const platform = createCoreTestPlatform();
    const getUserMedia = vi.fn(async () => stream([track("audio")]));
    let reject: (cause: unknown) => void = () => undefined;
    const setMicrophoneEnabled = vi.fn(
      () =>
        new Promise<never>((_resolve, rejectOn) => {
          reject = rejectOn;
        }),
    );
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia, enumerateDevices: async () => [] }, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled }) } },
    );
    try {
      await client.join({ microphone: true, camera: false });
      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledTimes(1));
      const left = client.leave();
      reject(new V1SyncError("client_stopped", "client_stopped"));
      await left;
      getUserMedia.mockClear();
      await client.join();
      expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.anything() }));
    } finally {
      client.dispose();
    }
  });

  it("does not ask Sync to turn on a camera the join could not capture", async () => {
    const platform = createCoreTestPlatform();
    const accepted = async () => ({ operationId: "on", name: "set_microphone_enabled" as const, serverOutcome: "confirmed" as const, mediaPlaneOutcome: "confirmed" as const });
    const setMicrophoneEnabled = vi.fn(accepted);
    const setCameraEnabled = vi.fn(accepted);
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.video) throw new DOMException("Video capture failed", "NotReadableError");
      return stream([track("audio")]);
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia, enumerateDevices: async () => [] }, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled, setCameraEnabled }) } },
    );
    try {
      await client.join({ microphone: true, camera: true });
      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledWith(true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(setCameraEnabled).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("turns a source off when Sync refuses its on at join", async () => {
    const setMicrophoneEnabled = vi.fn(async () => ({ operationId: "on", name: "set_microphone_enabled" as const, serverOutcome: "confirmed" as const, mediaPlaneOutcome: "confirmed" as const }));
    const setCameraEnabled = vi.fn(async () => {
      throw new V1SyncError("capability_denied", "terminal_failure");
    });
    const [microphone, camera] = [track("audio"), track("video")];
    const client = joinWith(setMicrophoneEnabled, setCameraEnabled, [microphone, camera]);
    try {
      await client.join({ microphone: true, camera: true });
      await vi.waitFor(() => expect(camera.enabled).toBe(false));
      expect(setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(microphone.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });
});
