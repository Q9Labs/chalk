import { Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import { mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import { makeSpaceClientCoreLayer, SpaceClientCoreService } from "./core";

it.each(["capture", "command"] as const)("can unmute after Sync ports are replaced during %s", async (stage) => {
  const original = createCoreTestPlatform();
  const replacement = createCoreTestPlatform();
  const track = Object.assign(mediaTrack(), { stop: vi.fn() });
  const retryTrack = mediaTrack();
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = vi.fn(async () => mediaStream(retryTrack));
  const command = vi.fn(async () => ({ operationId: "enable", name: "set_microphone_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" }) as const);
  if (stage === "capture")
    capture.mockImplementationOnce(async () => {
      await pending;
      return mediaStream(track);
    });
  else {
    capture.mockResolvedValueOnce(mediaStream(track));
    command.mockImplementationOnce(async () => {
      await pending;
      return { operationId: "enable", name: "set_microphone_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" };
    });
  }
  let clients = 0;
  const client = createSpaceClientForPlatform(
    { space: "test-space", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...original,
      dependencies: {
        ...original.dependencies,
        mediaDevices: { getUserMedia: capture, enumerateDevices: async () => [] },
        createSyncClient: () => ({ ...(++clients === 1 ? original.sync : replacement.sync), setMicrophoneEnabled: command }),
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    const first = client.media.setMicrophoneEnabled(true).then(
      () => "enabled",
      (cause: unknown) => cause,
    );
    await vi.waitFor(() => expect(stage === "capture" ? capture : command).toHaveBeenCalledOnce());
    original.emitSync({ ...original.sync.getSnapshot(), connection: { phase: "terminal" } });
    await vi.waitFor(() => expect(clients).toBe(2));
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
    release();
    const outcome = await first;
    expect(outcome).toMatchObject({ code: "connection.invalid_state", recoverable: true });
    await expect(client.media.setMicrophoneEnabled(true)).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(track.stop).toHaveBeenCalled();
  } finally {
    release();
    client.dispose();
  }
});

it.each(["leave", "supersede", "dispose"] as const)("classifies a pending capture cancelled by %s", async (action) => {
  const platform = createCoreTestPlatform();
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = vi.fn(async () => mediaStream(Object.assign(mediaTrack(), { kind: "video" })));
  capture.mockImplementationOnce(async () => {
    await pending;
    return mediaStream(Object.assign(mediaTrack(), { kind: "video" }));
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* SpaceClientCoreService;
          yield* core.join({ microphone: false, camera: false });
          const preview = yield* Effect.forkScoped(core.controllers.media.captureCameraPreview());
          yield* Effect.promise(() => vi.waitFor(() => expect(capture).toHaveBeenCalledOnce()));
          if (action === "leave") yield* core.leave();
          else if (action === "supersede") yield* core.controllers.media.selectCamera("another-camera");
          else core.controllers.media.dispose();
          release();
          const failure = yield* Effect.flip(Fiber.join(preview));
          expect(failure).toMatchObject({ code: "connection.invalid_state", recoverable: action !== "dispose" });
          if (action !== "dispose") {
            const retry = yield* core.controllers.media.captureCameraPreview();
            retry.release();
            expect(capture).toHaveBeenCalledTimes(2);
          }
        }),
      ).pipe(
        Effect.provide(
          makeSpaceClientCoreLayer(
            { space: "test-space", getAccess: async () => opaqueAccessGrant("test") },
            {
              ...platform,
              dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: capture, enumerateDevices: async () => [] } },
            },
          ),
        ),
      ),
    );
  } finally {
    release();
  }
});
