import { Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import { createEffectSpaceClient } from "./effect";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

it.each([false, true])("no-device preview failure leaves join healthy (devices initially enabled: %s)", async (enabled) => {
  const platform = createCoreTestPlatform();
  const getUserMedia = vi.fn(async () => {
    throw new DOMException("No capture device", "NotFoundError");
  });
  const start = vi.fn(async () => undefined);
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia, enumerateDevices: async () => [] }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }) } },
  );
  try {
    await client.join({ microphone: enabled, camera: enabled });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
    expect(client.getSnapshot().media.devices.cameras).toEqual([]);
    const before = client.getSnapshot();
    start.mockClear();
    getUserMedia.mockClear();
    await expect(client.media.captureCameraPreview()).rejects.toMatchObject({ code: "media.device_not_found", recoverable: true });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(client.getSnapshot().connection.status).toBe("live");
    expect(client.getSnapshot().media).toEqual(before.media);
    await client.leave();
    await client.join({ microphone: false, camera: false });
    expect(client.getSnapshot().connection.status).toBe("live");
  } finally {
    client.dispose();
  }
});

it("cleans up preview capture that resolves after the client is disposed", async () => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  let release = (_stream: MediaStream) => {};
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        release = resolve;
      }),
  );
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia, enumerateDevices: async () => [] } } });
  try {
    await client.join({ microphone: false, camera: false });
    const result = client.media.captureCameraPreview().then(
      (captured) => {
        captured.release();
        return "resolved";
      },
      () => "rejected",
    );
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await client.leave();
    client.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    release(stream([video]));
    expect(await result).toBe("rejected");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(video.stop).toHaveBeenCalled();
  } finally {
    client.dispose();
  }
});

it.each(["preview", "selected camera preview", "camera", "microphone", "join", "screen"] as const)("stops every late %s track after leaving, with or without disposal", async (path) => {
  for (const dispose of [false, true]) {
    const platform = createCoreTestPlatform();
    const audio = track("audio");
    const video = track("video");
    let release = (_stream: MediaStream) => {};
    const capture = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          release = resolve;
        }),
    );
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] } } });
    try {
      if (path !== "join") await client.join({ microphone: false, camera: false });
      if (path === "selected camera preview") await client.media.selectCamera("another-camera");
      const request = path === "join" ? client.join() : path === "screen" ? client.media.setScreenShareEnabled(true, { audio: true }) : path === "camera" ? client.media.setCameraEnabled(true) : path === "microphone" ? client.media.setMicrophoneEnabled(true) : client.media.captureCameraPreview();
      const result = request.then(
        () => "resolved",
        () => "rejected",
      );
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      await client.leave();
      if (dispose) client.dispose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      release(stream([audio, video]));
      expect(await result).toBe("rejected");
      await vi.waitFor(() => {
        expect(audio.stop).toHaveBeenCalled();
        expect(video.stop).toHaveBeenCalled();
      });
      expect(client.getSnapshot().media.local.camera.track).toBeNull();
      expect(client.getSnapshot().media.local.microphone.track).toBeNull();
      expect(client.getSnapshot().media.local.screen.track).toBeNull();
    } finally {
      release(stream([audio, video]));
      client.dispose();
    }
  }
});

it.each(["leave", "dispose"] as const)("stops an acquired preview while device refresh is pending on %s", async (action) => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  let refreshPending = false;
  let release = (_devices: readonly MediaDeviceInfo[]) => {};
  const enumerateDevices = vi.fn(() =>
    refreshPending
      ? new Promise<readonly MediaDeviceInfo[]>((resolve) => {
          release = resolve;
        })
      : Promise.resolve([]),
  );
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => stream([video]), enumerateDevices } } });
  try {
    await client.join({ microphone: false, camera: false });
    refreshPending = true;
    enumerateDevices.mockClear();
    const result = client.media.captureCameraPreview().then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce());
    if (action === "leave") await client.leave();
    else client.dispose();
    await vi.waitFor(() => expect(video.stop).toHaveBeenCalled());
    release([]);
    expect(await result).toBe("rejected");
  } finally {
    release([]);
    client.dispose();
  }
});

it.each(["preview", "camera", "microphone", "screen"] as const)("stops late %s capture when only the request is interrupted", async (path) => {
  const platform = createCoreTestPlatform();
  const audio = track("audio");
  const video = track("video");
  let release = (_stream: MediaStream) => {};
  const capture = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        release = resolve;
      }),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* createEffectSpaceClient({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] } } });
          yield* client.join({ microphone: false, camera: false });
          const request = path === "screen" ? client.media.setScreenShareEnabled(true, { audio: true }) : path === "camera" ? client.media.setCameraEnabled(true) : path === "microphone" ? client.media.setMicrophoneEnabled(true) : client.media.captureCameraPreview();
          const fiber = yield* Effect.forkScoped(request);
          yield* Effect.promise(() => vi.waitFor(() => expect(capture).toHaveBeenCalledOnce()));
          yield* Fiber.interrupt(fiber);
          release(stream([audio, video]));
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              expect(audio.stop).toHaveBeenCalled();
              expect(video.stop).toHaveBeenCalled();
            }),
          );
          expect(client.getSnapshot().connection.status).toBe("live");
        }),
      ),
    );
  } finally {
    release(stream([audio, video]));
  }
});

it.each(["enable first", "preview first", "prepared"] as const)("shares one camera source when %s", async (order) => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  let release = (_stream: MediaStream) => {};
  let publish = () => {};
  const captured = new Promise<MediaStream>((resolve) => {
    release = resolve;
  });
  const publishing = new Promise<void>((resolve) => {
    publish = resolve;
  });
  const getUserMedia = vi.fn(() => captured);
  const requests: Promise<unknown>[] = [];
  const prepareLocalTrack = vi.fn();
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia, enumerateDevices: async () => [] },
        createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), prepareLocalTrack }),
        createSyncClient: (input) => ({
          ...platform.dependencies.createSyncClient(input),
          setCameraEnabled: async () => {
            await publishing;
            return { operationId: "enable", name: "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
          },
        }),
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    const previewFirst = order === "preview first" ? client.media.captureCameraPreview() : undefined;
    const enabling = client.media.setCameraEnabled(true);
    requests.push(enabling);
    if (previewFirst) requests.push(previewFirst);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    if (order === "prepared") {
      release(stream([video]));
      await vi.waitFor(() => expect(prepareLocalTrack).toHaveBeenCalledWith("camera", video));
    }
    const preview = previewFirst ?? client.media.captureCameraPreview();
    requests.push(preview);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getUserMedia).toHaveBeenCalledOnce();
    release(stream([video]));
    const lease = await preview;
    expect(lease.track).toBe(video);
    expect(client.getSnapshot().media.local.camera.track).toBe(video);
    lease.release();
    lease.release();
    expect(video.stop).not.toHaveBeenCalled();
    publish();
    await enabling;
    await client.leave();
    expect(video.stop).toHaveBeenCalled();
  } finally {
    release(stream([video]));
    publish();
    client.dispose();
    await Promise.allSettled(requests);
  }
});

it("shares the camera acquisition already pending during join", async () => {
  const platform = createCoreTestPlatform();
  const audio = track("audio");
  const video = track("video");
  let release = (_stream: MediaStream) => {};
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        release = resolve;
      }),
  );
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia, enumerateDevices: async () => [] } } });
  try {
    const joining = client.join();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    const preview = client.media.captureCameraPreview();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getUserMedia).toHaveBeenCalledOnce();
    release(stream([audio, video]));
    const lease = await preview;
    await joining;
    expect(lease.track).toBe(video);
    lease.release();
    expect(video.stop).not.toHaveBeenCalled();
    await client.leave();
    expect(audio.stop).toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalled();
  } finally {
    release(stream([audio, video]));
    client.dispose();
  }
});

it("stops a private preview on leave even after handing it to its caller", async () => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => stream([video]), enumerateDevices: async () => [] } } });
  try {
    await client.join({ microphone: false, camera: false });
    const lease = await client.media.captureCameraPreview();
    expect(lease.track).toBe(video);
    expect(video.stop).not.toHaveBeenCalled();
    await client.leave();
    expect(video.stop).toHaveBeenCalled();
    lease.release();
  } finally {
    client.dispose();
  }
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
