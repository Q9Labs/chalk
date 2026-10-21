import { Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import type { EffectSpaceClient } from "./effect";
import { createEffectSpaceClient } from "./effect";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { captureClient, noCaptureDevices, pendingCapture, pendingPreview, pendingMedia, stream, track } from "./capture.test.helpers";

it.each([false, true])("no-device preview failure leaves join healthy (devices initially enabled: %s)", async (enabled) => {
  const platform = createCoreTestPlatform();
  const getUserMedia = vi.fn(noCaptureDevices);
  const start = vi.fn(async () => undefined);
  const client = captureClient(platform, { mediaDevices: { getUserMedia, enumerateDevices: async () => [] }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }) });
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
  const { video, capture: getUserMedia, release, client } = pendingPreview();
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
    const { platform, audio, video, capture, release } = pendingMedia();
    const client = captureClient(platform, { mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] } });
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
  const client = captureClient(platform, { mediaDevices: { getUserMedia: async () => stream([video]), enumerateDevices } });
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

it.each([
  ["preview", (client: EffectSpaceClient) => client.media.captureCameraPreview().pipe(Effect.asVoid)],
  ["camera", (client: EffectSpaceClient) => client.media.setCameraEnabled(true)],
  ["microphone", (client: EffectSpaceClient) => client.media.setMicrophoneEnabled(true)],
  ["screen", (client: EffectSpaceClient) => client.media.setScreenShareEnabled(true, { audio: true })],
] as const)("stops late %s capture when only the request is interrupted", async (_path, captureRequest) => {
  const { platform, audio, video, capture, release } = pendingMedia();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* createEffectSpaceClient({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] } } });
          yield* client.join({ microphone: false, camera: false });
          const request = captureRequest(client);
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
  const client = captureClient(platform, {
    mediaDevices: { getUserMedia, enumerateDevices: async () => [] },
    createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), prepareLocalTrack }),
    createSyncClient: (input) => ({
      ...platform.dependencies.createSyncClient(input),
      setCameraEnabled: async () => {
        await publishing;
        return { operationId: "enable", name: "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
      },
    }),
  });
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
  const { capture: getUserMedia, release } = pendingCapture();
  const client = captureClient(platform, { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
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
  const client = captureClient(platform, { mediaDevices: { getUserMedia: async () => stream([video]), enumerateDevices: async () => [] } });
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

it("revokes pending preview leases on leave before browser capture resolves", async () => {
  const { video, capture: getUserMedia, release, client } = pendingPreview();
  let outcome = "pending";
  try {
    await client.join({ microphone: false, camera: false });
    const request = client.media.captureCameraPreview().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await client.leave();
    await vi.waitFor(() => expect(outcome).toBe("rejected"));
    release(stream([video]));
    await request;
    await vi.waitFor(() => expect(video.stop).toHaveBeenCalled());
  } finally {
    release(stream([video]));
    client.dispose();
  }
});

it.each(["enable", "join", "selection"] as const)("recaptures on %s after a private camera becomes obsolete", async (operation) => {
  const platform = createCoreTestPlatform();
  const first = track("video");
  const second = track("video");
  const capture = vi
    .fn()
    .mockResolvedValueOnce(stream([first]))
    .mockResolvedValueOnce(stream([second]));
  const prepared: MediaStreamTrack[] = [];
  const client = captureClient(platform, {
    createSyncClient: (input) => ({ ...platform.dependencies.createSyncClient(input), setCameraEnabled: async () => ({ operationId: "enable", name: "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" }) }),
    mediaDevices: { getUserMedia: capture, enumerateDevices: async () => [] },
    createMediaClient: (input) => ({
      ...platform.dependencies.createMediaClient(input),
      prepareLocalTrack: (_source, value) => {
        prepared.push(value);
      },
    }),
  });
  try {
    if (operation === "enable") await client.join({ microphone: false, camera: false });
    const preview = await client.media.captureCameraPreview();
    if (operation === "selection") await client.media.selectCamera("camera-b");
    else {
      first.stop();
      first.dispatchEvent(new Event("ended"));
    }
    expect(first.readyState).toBe("ended");
    if (operation === "enable") await client.media.setCameraEnabled(true);
    else await client.join({ microphone: false, camera: true });
    expect(capture).toHaveBeenCalledTimes(2);
    if (operation === "enable") expect(prepared).toEqual([second]);
    if (operation === "selection") {
      expect(capture).toHaveBeenNthCalledWith(2, { audio: false, video: { deviceId: { exact: "camera-b" } } });
      expect(client.getSnapshot().media.selection.camera).toBe("camera-b");
    }
    expect(client.getSnapshot().media.local.camera.track).toBe(second);
    preview.release();
    expect(second.readyState).toBe("live");
  } finally {
    client.dispose();
  }
});

it("publishes removal when selecting a camera while disabled", async () => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  const client = captureClient(platform, {
    createSyncClient: (input) => ({ ...platform.dependencies.createSyncClient(input), setCameraEnabled: async () => ({ operationId: "enable", name: "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" }) }),
    mediaDevices: { getUserMedia: async () => stream([video]), enumerateDevices: async () => [] },
  });
  try {
    await client.join({ microphone: false, camera: true });
    await client.media.setCameraEnabled(false);
    expect(client.getSnapshot().media.local.camera.track).toBe(video);
    const snapshots: (MediaStreamTrack | null)[] = [];
    const unsubscribe = client.subscribe(() => snapshots.push(client.getSnapshot().media.local.camera.track));
    await client.media.selectCamera("another-camera");
    unsubscribe();
    expect(video.readyState).toBe("ended");
    expect(client.getSnapshot().media.local.camera.track).toBeNull();
    expect(snapshots.at(-1)).toBeNull();
  } finally {
    client.dispose();
  }
});

it("keeps a borrowed preview live across a rejected enable and retry", async () => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  const capture = vi.fn(async () => stream([video]));
  const prepared: MediaStreamTrackState[] = [];
  let attempts = 0;
  const client = captureClient(platform, {
    mediaDevices: { getUserMedia: capture, enumerateDevices: async () => [] },
    createMediaClient: (input) => ({
      ...platform.dependencies.createMediaClient(input),
      prepareLocalTrack: (_source, value) => {
        prepared.push(value.readyState);
      },
      clearPreparedLocalTrack: async (_source, options) => {
        video.enabled = false;
        if (options?.stopTrack !== false) video.stop();
      },
    }),
    createSyncClient: (input) => ({
      ...platform.dependencies.createSyncClient(input),
      setCameraEnabled: async () => {
        if (++attempts === 1) throw new Error("Enable rejected");
        return { operationId: "enable", name: "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
      },
    }),
  });
  try {
    await client.join({ microphone: false, camera: false });
    const preview = await client.media.captureCameraPreview();
    await expect(client.media.setCameraEnabled(true)).rejects.toBeDefined();
    expect(preview.track.readyState).toBe("live");
    expect(preview.track.enabled).toBe(true);
    await client.media.setCameraEnabled(true);
    expect(capture).toHaveBeenCalledOnce();
    expect(prepared).toEqual(["live", "live"]);
    preview.release();
    expect(video.readyState).toBe("live");
  } finally {
    client.dispose();
  }
});

it("keeps an ended shared acquisition in the typed error channel", async () => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  let resolveCapture = (_stream: MediaStream) => {};
  const capture = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        resolveCapture = resolve;
      }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* createEffectSpaceClient({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: capture, enumerateDevices: async () => [] } } });
        yield* client.join({ microphone: false, camera: false });
        const first = yield* Effect.forkScoped(
          client.media.captureCameraPreview().pipe(
            Effect.tap((preview) =>
              Effect.sync(() => {
                preview.track.stop();
                preview.track.dispatchEvent(new Event("ended"));
                preview.release();
              }),
            ),
          ),
        );
        yield* Effect.promise(() => vi.waitFor(() => expect(capture).toHaveBeenCalledOnce()));
        const second = yield* Effect.forkScoped(client.media.captureCameraPreview().pipe(Effect.catch((error) => Effect.succeed({ handled: error.code }))));
        yield* Effect.yieldNow;
        resolveCapture(stream([video]));
        yield* Fiber.join(first);
        const result = yield* Effect.exit(Fiber.join(second));
        expect(result).toMatchObject({ _tag: "Success", value: { handled: "connection.invalid_state" } });
      }),
    ),
  );
});

it("leaves an already enabled camera publication untouched", async () => {
  const platform = createCoreTestPlatform();
  const video = track("video");
  const capture = vi.fn(async () => stream([video]));
  const clear = vi.fn(async () => undefined);
  const prepare = vi.fn();
  const enable = vi.fn(async () => ({ operationId: "enable", name: "set_camera_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const }));
  const client = captureClient(platform, {
    mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] },
    createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), clearPreparedLocalTrack: clear, prepareLocalTrack: prepare }),
    createSyncClient: (input) => ({ ...platform.dependencies.createSyncClient(input), setCameraEnabled: enable }),
  });
  try {
    await client.join({ microphone: false, camera: true });
    clear.mockClear();
    prepare.mockClear();
    await client.media.setCameraEnabled(true);
    expect(clear).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledOnce();
    expect(client.getSnapshot().media.local.camera.track).toBe(video);
    expect(video.readyState).toBe("live");
  } finally {
    client.dispose();
  }
});

it.each(["device selection", "ended event", "stopped track", "leave", "failed clear", "failed clear with preview"])("clears the SFU camera slot after %s before enabling a replacement", async (retirement) => {
  const platform = createCoreTestPlatform();
  const first = track("video");
  const replacement = track("video");
  const capture = vi
    .fn()
    .mockResolvedValueOnce(stream([first]))
    .mockResolvedValueOnce(stream([replacement]));
  let prepared: MediaStreamTrack | null = null;
  const prepare = vi.fn((_source: string, value: MediaStreamTrack) => {
    if (prepared) throw new Error("A camera track is already prepared");
    prepared = value;
  });
  let failedClear = false;
  const clear = vi.fn(async () => {
    const retiring = prepared;
    if (retiring && retirement.startsWith("failed clear") && !failedClear) {
      failedClear = true;
      throw new Error("replaceTrack failed");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (prepared === retiring) prepared = null;
  });
  const client = captureClient(platform, {
    mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] },
    createMediaClient: (input) => {
      const media = platform.dependencies.createMediaClient(input);
      return {
        ...media,
        prepareLocalTrack: prepare,
        clearPreparedLocalTrack: clear,
        stop: () => {
          prepared = null;
          media.stop();
        },
      };
    },
    createSyncClient: (input) => ({ ...platform.dependencies.createSyncClient(input), setCameraEnabled: async () => ({ operationId: "enable", name: "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" }) }),
  });
  try {
    await client.join({ microphone: false, camera: false });
    await client.media.setCameraEnabled(true);
    expect(prepared).toBe(first);
    await client.media.setCameraEnabled(false);
    if (retirement.startsWith("failed clear")) {
      await client.media.selectCamera("another-camera").catch(() => undefined);
      await vi.waitFor(() => expect(failedClear).toBe(true));
    } else if (retirement === "device selection") await client.media.selectCamera("another-camera");
    else if (retirement === "ended event") {
      first.stop();
      first.dispatchEvent(new Event("ended"));
    } else if (retirement === "stopped track") first.stop();
    else {
      await client.leave();
      await client.join({ microphone: false, camera: false });
    }
    const preview = retirement === "failed clear with preview" ? await client.media.captureCameraPreview() : undefined;
    await expect(client.media.setCameraEnabled(true)).resolves.toBeUndefined();
    expect(prepared).toBe(replacement);
    expect(capture).toHaveBeenCalledTimes(2);
    if (preview) {
      expect(preview.track).toBe(replacement);
      preview.release();
    }
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalled();
    expect(first.readyState).toBe("ended");
    expect(replacement.readyState).toBe("live");
  } finally {
    client.dispose();
  }
  await vi.waitFor(() => expect(prepared).toBeNull());
  expect(clear).toHaveBeenCalled();
});
