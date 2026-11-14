import { describe, expect, it, vi } from "vitest";
import { mediaStream } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import type { ConnectionDependencies, ConnectionMediaDevices } from "../connection/dependencies";
import { createSpaceClientForPlatform } from "./space-client";
import { captureTrack, IDLE_MS, rig, type Source } from "../../tests/helpers/media-idle-release-rig";

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

  it("schedules no release once its capture is already gone", async () => {
    const { client, set, captured, timers } = await rig(source);
    try {
      captured[0]?.stop();
      timers.clear();
      await set(false);
      expect([...timers.values()].filter((ms) => ms === IDLE_MS)).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it("schedules no release once the connection has dropped it", async () => {
    const { client, set, timers } = await rig(source);
    try {
      await set(false);
      expect([...timers.values()]).toContain(IDLE_MS);
      await client.leave();
      expect([...timers.values()].filter((ms) => ms === IDLE_MS)).toEqual([]);
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
        apiBaseUrl: "http://localhost:8080",
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

function streamOf(...tracks: MediaStreamTrack[]): MediaStream {
  const [first] = tracks;
  if (!first) return mediaStream(captureTrack("audio"));
  return Object.assign(mediaStream(first), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  });
}

/** An adapter that keeps its state on `this`, as a native module wrapper does. Calling `releaseTrack` detached from it throws. */
class StatefulDevices implements ConnectionMediaDevices {
  readonly released: MediaStreamTrack[] = [];
  readonly failing = new Set<MediaStreamTrack>();
  constructor(readonly streams: () => MediaStream) {}
  getUserMedia = async () => this.streams();
  getDisplayMedia = async () => this.streams();
  enumerateDevices = async () => [];
  releaseTrack(track: MediaStreamTrack): void {
    if (this.failing.has(track)) throw new Error("native release failed");
    this.released.push(track);
    track.stop();
  }
}

describe("an adapter whose releaseTrack uses this", () => {
  function clientWith(devices: StatefulDevices, overrides: Partial<ConnectionDependencies> = {}) {
    const base = createCoreTestPlatform();
    return createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...base, apiBaseUrl: "http://localhost:8080", dependencies: { ...base.dependencies, mediaDevices: devices, ...overrides } });
  }
  const syncDown = (): Partial<ConnectionDependencies> => {
    const base = createCoreTestPlatform();
    return { createSyncClient: () => ({ ...base.sync, start: async () => Promise.reject(new Error("Sync is down")) }) };
  };

  it("releases the captured tracks when the join fails", async () => {
    const microphone = captureTrack("audio");
    const devices = new StatefulDevices(() => mediaStream(microphone));
    const client = clientWith(devices, syncDown());

    await client.join({ microphone: true, camera: false }).catch(() => undefined);

    expect(new Set(devices.released)).toEqual(new Set([microphone]));
    client.dispose();
  });

  it("releases every captured track when one release throws, and the join still reports its own failure", async () => {
    const microphone = captureTrack("audio");
    const camera = captureTrack("video");
    const devices = new StatefulDevices(() => streamOf(microphone, camera));
    devices.failing.add(microphone);
    const client = clientWith(devices, syncDown());

    const failure = await client.join({ microphone: true, camera: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(new Set(devices.released)).toEqual(new Set([camera]));
    expect(String(failure)).not.toContain("native release failed");
    client.dispose();
  });

  it("releases the local tracks on Leave even when the first release throws", async () => {
    const microphone = captureTrack("audio");
    const camera = captureTrack("video");
    const devices = new StatefulDevices(() => streamOf());
    const base = createCoreTestPlatform();
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...base, apiBaseUrl: "http://localhost:8080", dependencies: { ...base.dependencies, mediaDevices: devices } });
    await client.join({ microphone: false, camera: false });
    const publication = { participantId: "participant-1", enabled: true };
    base.media.emit({
      ...base.media.getSnapshot(),
      localTracks: [
        { ...publication, source: "microphone", publicationId: "publication-1", track: microphone },
        { ...publication, source: "camera", publicationId: "publication-2", track: camera },
      ],
    });
    devices.failing.add(microphone);

    await client.leave();

    expect(new Set(devices.released)).toEqual(new Set([camera]));
    client.dispose();
  });
});
