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

    expect(releaseTrack).toHaveBeenCalledWith(microphone);
    expect(releaseTrack).toHaveBeenCalledWith(camera);
    expect(microphone.enabled).toBe(false);
    expect(camera.enabled).toBe(false);
    client.dispose();
  });
});

describe.each(["microphone", "camera"] as const)("a %s that Sync or the device turns off", (source) => {
  it("is released 30 s after a moderator mute, not before", async () => {
    const { clock, client, captured, releaseTrack, base } = await rig(source);
    try {
      base.emitMediaPause({ source, revision: 2 });
      clock.advance(IDLE_MS - 1);
      expect(releaseTrack).not.toHaveBeenCalled();
      clock.advance(1);
      expect(releaseTrack).toHaveBeenCalledExactlyOnceWith(captured[0]);
    } finally {
      client.dispose();
    }
  });

  it("is kept when the user turns it back on within the 30 s", async () => {
    const { clock, client, set, releaseTrack, base } = await rig(source);
    try {
      base.emitMediaPause({ source, revision: 2 });
      clock.advance(IDLE_MS - 1);
      await set(true);
      clock.advance(IDLE_MS * 2);
      expect(releaseTrack).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("is released when the client is disposed without Leave", async () => {
    const { client, captured, releaseTrack } = await rig(source);
    client.dispose();
    expect(releaseTrack).toHaveBeenCalledWith(captured[0]);
  });
});

it("releases a microphone the OS muted, 30 s after the interruption", async () => {
  const { clock, client, captured, releaseTrack } = await rig("microphone");
  try {
    const microphone = captured[0];
    if (!microphone) throw new Error("The rig captured no microphone");
    Object.defineProperty(microphone, "muted", { value: true });
    microphone.dispatchEvent(new Event("mute"));
    clock.advance(IDLE_MS);
    expect(releaseTrack).toHaveBeenCalledExactlyOnceWith(microphone);
  } finally {
    client.dispose();
  }
});

describe("a capture that finishes after nobody wants it", () => {
  it("releases a microphone that resolves after the client is disposed", async () => {
    const base = createCoreTestPlatform();
    const late = captureTrack("audio");
    const pending = Promise.withResolvers<MediaStream>();
    const releaseTrack = vi.fn();
    const getUserMedia = vi.fn(() => pending.promise);
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...base, dependencies: { ...base.dependencies, mediaDevices: { getUserMedia, getDisplayMedia: getUserMedia, enumerateDevices: async () => [], releaseTrack } } });
    await client.join({ microphone: false, camera: false });
    const enabling = client.media.setMicrophoneEnabled(true).catch(() => "rejected");
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    client.dispose();
    pending.resolve(mediaStream(late));
    await enabling;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releaseTrack).toHaveBeenCalledWith(late);
  });
});

describe("a join that fails after the devices opened", () => {
  it("releases the tracks it captured", async () => {
    const base = createCoreTestPlatform();
    const microphone = captureTrack("audio");
    const releaseTrack = vi.fn();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...base,
        dependencies: {
          ...base.dependencies,
          mediaDevices: { getUserMedia: async () => mediaStream(microphone), getDisplayMedia: async () => mediaStream(microphone), enumerateDevices: async () => [], releaseTrack },
          createSyncClient: () => ({ ...base.sync, start: async () => Promise.reject(new Error("Sync is down")) }),
        },
      },
    );
    await client.join({ microphone: true, camera: false }).catch(() => undefined);
    expect(releaseTrack).toHaveBeenCalledWith(microphone);
    client.dispose();
  });

  it("releases the microphone it opened when the camera capture is cut off by Leave", async () => {
    const base = createCoreTestPlatform();
    const microphone = captureTrack("audio");
    const releaseTrack = vi.fn();
    const camera = Promise.withResolvers<MediaStream>();
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio && constraints.video) throw new DOMException("No camera", "NotFoundError");
      if (constraints.audio) return mediaStream(microphone);
      return camera.promise;
    });
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...base, dependencies: { ...base.dependencies, mediaDevices: { getUserMedia, getDisplayMedia: getUserMedia, enumerateDevices: async () => [], releaseTrack } } });
    const joining = client.join({ microphone: true, camera: true }).catch(() => undefined);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    client.dispose();
    camera.resolve(mediaStream(captureTrack("video")));
    await joining;
    expect(releaseTrack).toHaveBeenCalledWith(microphone);
  });
});
