import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

const IDLE_MS = 30_000;
type Source = "microphone" | "camera";

/** A capture track that ends the way a real one does: `stop()` marks it ended. */
function captureTrack(kind: "audio" | "video"): MediaStreamTrack {
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

async function rig(source: Source) {
  const clock = new ManualClock();
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
        clock: { now: () => clock.now(), setTimeout: (callback, ms) => clock.setTimeout(callback, ms), clearTimeout: (handle) => clock.clearTimeout(handle) },
        mediaDevices: { getUserMedia, getDisplayMedia: getUserMedia, enumerateDevices: async () => [], releaseTrack },
        createMediaClient: (input) => ({ ...base.dependencies.createMediaClient(input), prepareLocalTrack, clearPreparedLocalTrack }),
      },
    },
  );
  const set = source === "microphone" ? client.media.setMicrophoneEnabled : client.media.setCameraEnabled;
  await client.join({ microphone: false, camera: false });
  await set(true);
  return { clock, client, set, captured, getUserMedia, releaseTrack, prepareLocalTrack, base };
}

describe.each(["microphone", "camera"] as const)("a muted %s", (source) => {
  it("is released 30 s after the mute, not before", async () => {
    const { clock, client, set, captured, releaseTrack } = await rig(source);
    try {
      await set(false);
      clock.advance(IDLE_MS - 1);
      expect(releaseTrack).not.toHaveBeenCalled();
      clock.advance(1);
      expect(releaseTrack).toHaveBeenCalledExactlyOnceWith(captured[0]);
    } finally {
      client.dispose();
    }
  });

  it("is kept when the user unmutes before the 30 s are up", async () => {
    const { clock, client, set, releaseTrack } = await rig(source);
    try {
      await set(false);
      clock.advance(IDLE_MS - 1);
      await set(true);
      clock.advance(IDLE_MS * 2);
      expect(releaseTrack).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("restarts the 30 s on every mute", async () => {
    const { clock, client, set, releaseTrack } = await rig(source);
    try {
      await set(false);
      clock.advance(IDLE_MS - 1);
      await set(true);
      await set(false);
      clock.advance(IDLE_MS - 1);
      expect(releaseTrack).not.toHaveBeenCalled();
      clock.advance(1);
      expect(releaseTrack).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
    }
  });

  it("is not released after the client is disposed", async () => {
    const { clock, client, set, releaseTrack } = await rig(source);
    await set(false);
    client.dispose();
    releaseTrack.mockClear();
    clock.advance(IDLE_MS * 2);
    expect(releaseTrack).not.toHaveBeenCalled();
  });

  it("captures a fresh track on unmute after the release, and never hands the ended one back", async () => {
    const { clock, client, set, captured, getUserMedia, prepareLocalTrack } = await rig(source);
    try {
      await set(false);
      clock.advance(IDLE_MS);
      expect(captured[0]?.readyState).toBe("ended");
      prepareLocalTrack.mockClear();

      await set(true);

      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(prepareLocalTrack).toHaveBeenCalledExactlyOnceWith(source, captured[1]);
      expect(captured[1]?.readyState).toBe("live");
    } finally {
      client.dispose();
    }
  });

  it("reuses the live track when the user unmutes within the 30 s", async () => {
    const { client, set, getUserMedia } = await rig(source);
    try {
      await set(false);
      await set(true);
      expect(getUserMedia).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
    }
  });
});

describe("Leave", () => {
  it("releases every local track, so the OS capture ends with the call", async () => {
    const { client, base, releaseTrack } = await rig("microphone");
    const microphone = captureTrack("audio");
    const camera = captureTrack("video");
    const publication = { participantId: "participant-1", enabled: true };
    base.media.emit({
      ...base.media.getSnapshot(),
      localTracks: [
        { ...publication, source: "microphone", publicationId: "publication-1", track: microphone },
        { ...publication, source: "camera", publicationId: "publication-2", track: camera },
      ],
    });
    releaseTrack.mockClear();

    await client.leave();

    expect(releaseTrack.mock.calls.map(([track]) => track)).toEqual([microphone, camera]);
    expect(microphone.enabled).toBe(false);
    expect(camera.enabled).toBe(false);
    client.dispose();
  });
});
