import { expect, it, vi } from "vitest";
import type { ConnectionSyncClient } from "../connection/dependencies";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { stream, track } from "./capture.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

it.each([false, true])("publishes a consented screen capture after a short reconnect (system stopped capture: %s)", async (stopped) => {
  const platform = createCoreTestPlatform();
  const screen = track("video");
  const pickerOpened = Promise.withResolvers<void>();
  const pickerResult = Promise.withResolvers<MediaStream>();
  const screenCommands: boolean[] = [];
  const released = new Set<MediaStreamTrack>();
  const setScreenShareEnabled: ConnectionSyncClient["setScreenShareEnabled"] = async (enabled) => {
    screenCommands.push(enabled);
    return { operationId: "screen", name: "set_screen_share_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
  };
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: {
          ...platform.dependencies.mediaDevices,
          getDisplayMedia: () => {
            pickerOpened.resolve();
            return pickerResult.promise;
          },
          releaseTrack: (track) => {
            released.add(track);
            track.stop();
          },
        },
        createSyncClient: () => ({
          ...platform.sync,
          setScreenShareEnabled,
          offReasonNegotiated: () => true,
          link: { proof: () => ({ wall: 0, mono: 0, suspends: 0 }), longSince: () => false },
        }),
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    const sharing = client.media.setScreenShareEnabled(true);
    void sharing.catch(() => {});
    await pickerOpened.promise;
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
    pickerResult.resolve(stream([screen]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(screen.readyState).toBe("live");
    expect(screenCommands).toEqual([]);
    if (stopped) screen.stop();
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
    if (stopped) await expect(sharing).rejects.toMatchObject({ code: "connection.invalid_state" });
    else await sharing;
    expect(screenCommands).toEqual(stopped ? [] : [true]);
    expect(released.has(screen)).toBe(stopped);
  } finally {
    pickerResult.resolve(stream([screen]));
    client.dispose();
  }
});

it("replays Stop, not a late Enable, when Sync recovers", async () => {
  const platform = createCoreTestPlatform();
  const microphone = track("audio");
  const releaseEnable = Promise.withResolvers<void>();
  const enableSent = Promise.withResolvers<void>();
  const wireTargets: boolean[] = [];
  const setMicrophoneEnabled: ConnectionSyncClient["setMicrophoneEnabled"] = async (enabled) => {
    wireTargets.push(enabled);
    if (enabled) {
      enableSent.resolve();
      await releaseEnable.promise;
    }
    return { operationId: "microphone", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
  };
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia: async () => stream([microphone]), releaseTrack: (released) => released.stop() },
        createSyncClient: () => ({
          ...platform.sync,
          setMicrophoneEnabled,
          offReasonNegotiated: () => true,
          link: { proof: () => ({ wall: 0, mono: 0, suspends: 0 }), longSince: () => false },
        }),
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    const enabling = client.media.setMicrophoneEnabled(true).catch((cause: unknown) => cause);
    await enableSent.promise;
    const stopping = client.media.setMicrophoneEnabled(false);
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
    releaseEnable.resolve();
    await Promise.all([enabling, stopping]);
    expect(microphone.enabled).toBe(false);
    wireTargets.length = 0;
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
    await vi.waitFor(() => expect(wireTargets).toEqual([false]));
    expect(microphone.enabled).toBe(false);
  } finally {
    releaseEnable.resolve();
    client.dispose();
  }
});
