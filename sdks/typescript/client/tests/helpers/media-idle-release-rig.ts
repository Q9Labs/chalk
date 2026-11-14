import { vi } from "vitest";
import { ManualClock } from "./manual-clock";
import { mediaStream, mediaTrack } from "./media-convergence";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../src/space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../../src/space-client/space-client";

export const IDLE_MS = 30_000;
export type Source = "microphone" | "camera";

/** A capture track that ends the way a real one does: `stop()` marks it ended. */
export function captureTrack(kind: "audio" | "video"): MediaStreamTrack {
  let readyState: MediaStreamTrackState = "live";
  const track = Object.assign(mediaTrack(), {
    kind,
    stop: vi.fn(() => {
      readyState = "ended";
    }),
  });
  Object.defineProperty(track, "readyState", { get: () => readyState });
  return track;
}

export async function rig(source: Source) {
  const clock = new ManualClock();
  const timers = new Map<unknown, number>();
  const base = createCoreTestPlatform();
  const kind = source === "microphone" ? "audio" : "video";
  const captured: MediaStreamTrack[] = [];
  const getUserMedia = vi.fn(async () => {
    const track = captureTrack(kind);
    captured.push(track);
    return mediaStream(track);
  });
  const releaseTrack = vi.fn((track: MediaStreamTrack) => track.stop());
  const prepareLocalTrack = vi.fn<(source: string, track: MediaStreamTrack) => void>();
  const clearPreparedLocalTrack = vi.fn(async () => undefined);
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...base,
      dependencies: {
        ...base.dependencies,
        clock: {
          now: () => clock.now(),
          setTimeout: (callback, ms) => {
            const handle = clock.setTimeout(() => {
              timers.delete(handle);
              callback();
            }, ms);
            timers.set(handle, ms);
            return handle;
          },
          clearTimeout: (handle) => {
            timers.delete(handle);
            clock.clearTimeout(handle);
          },
        },
        mediaDevices: { getUserMedia, getDisplayMedia: getUserMedia, enumerateDevices: async () => [], releaseTrack },
        createMediaClient: (input) => ({ ...base.dependencies.createMediaClient(input), prepareLocalTrack, clearPreparedLocalTrack }),
      },
    },
  );
  const set = source === "microphone" ? client.media.setMicrophoneEnabled : client.media.setCameraEnabled;
  await client.join({ microphone: false, camera: false });
  await set(true);
  return { clock, client, set, captured, getUserMedia, releaseTrack, prepareLocalTrack, base, timers };
}
