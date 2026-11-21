import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { CloudflareSFUError } from "../media";
import { track } from "../space-client/capture.test.helpers";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

it.each([
  { name: "waits through the server's provider cleanup budget", delay: 35_000, acknowledged: true },
  { name: "still fails when durable cleanup exceeds the client budget", delay: 40_001, acknowledged: false },
])("durable Leave $name", async ({ delay, acknowledged }) => {
  const platform = createCoreTestPlatform();
  const clock = new ManualClock();
  clock.advance(Date.now());
  const acknowledgement = Promise.withResolvers<Awaited<ReturnType<typeof platform.sync.leave>>>();
  const leaveSent = Promise.withResolvers<void>();
  const shutdown: string[] = [];
  const sync = {
    ...platform.sync,
    leave: () => {
      leaveSent.resolve();
      return acknowledgement.promise;
    },
    stop: () => {
      shutdown.push("sync");
    },
  };
  const microphone = track("audio");
  const camera = track("video");
  const stopMedia = () => {
    shutdown.push("media");
    microphone.stop();
    camera.stop();
  };
  let rejectMedia: ((cause: unknown) => void) | undefined;
  const client = createSpaceClientForPlatform(
    { space: "leave-proof", getAccess: async () => opaqueAccessGrant(1) },
    {
      dependencies: {
        ...platform.dependencies,
        createSyncClient: () => sync,
        createMediaClient: (input) => {
          rejectMedia = input.onFailure;
          return { ...platform.dependencies.createMediaClient(input), stop: stopMedia };
        },
        clock: { now: () => clock.now(), setTimeout: (callback, delay) => clock.setTimeout(callback, delay), clearTimeout: (handle) => clock.clearTimeout(handle) },
        cancelPendingAdmission: async () => false,
      },
    },
  );
  let leaving: Promise<boolean> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    platform.media.emit({
      ...platform.media.getSnapshot(),
      localTracks: [
        { source: "microphone", enabled: true, publicationId: "microphone", track: microphone },
        { source: "camera", enabled: true, publicationId: "camera", track: camera },
      ],
    });
    leaving = client.leave().then(
      () => true,
      () => false,
    );
    await leaveSent.promise;
    expect(microphone.readyState).toBe("ended");
    expect(camera.readyState).toBe("ended");
    rejectMedia?.(new CloudflareSFUError("Leaving participant cannot poll publications", "signaling_failed", { status: 403 }));
    expect(shutdown).toEqual([]);
    clock.advance(delay);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    acknowledgement.resolve({ type: "ack", command_id: "leave", outcome: "satisfied", revision: 2, state_digest: "digest" });
    expect(await leaving).toBe(acknowledged);
    expect(client.getSnapshot().connection.status).toBe("left");
    expect(shutdown.sort()).toEqual(["media", "sync"]);
  } finally {
    acknowledgement.resolve({ type: "ack", command_id: "leave", outcome: "satisfied", revision: 2, state_digest: "digest" });
    await leaving;
    client.dispose();
  }
});
