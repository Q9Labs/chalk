import { describe, expect, it, vi } from "vitest";

import { createBrowserMediaDevices, requireDisplayVideoTrack, stopStream, streamFromTracks } from "./media-devices";

describe("browser media device helpers", () => {
  it("delegates capture constraints through the injected browser port", async () => {
    const captured = fakeStream([]);
    const getUserMedia = vi.fn().mockResolvedValue(captured);
    const getDisplayMedia = vi.fn().mockResolvedValue(captured);
    const devices = createBrowserMediaDevices({ getUserMedia, getDisplayMedia } as unknown as MediaDevices);

    await expect(devices.getUserMedia({ audio: true })).resolves.toBe(captured);
    await expect(devices.getDisplayMedia({ video: true })).resolves.toBe(captured);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("selects only display video and stops discarded or missing tracks", () => {
    const video = fakeTrack("video");
    const audio = fakeTrack("audio");
    expect(requireDisplayVideoTrack(fakeStream([video, audio]))).toBe(video);
    expect(audio.stop).toHaveBeenCalledTimes(1);

    const orphan = fakeTrack("audio");
    expect(() => requireDisplayVideoTrack(fakeStream([orphan]))).toThrow("did not return a video track");
    expect(orphan.stop).toHaveBeenCalledTimes(1);
    stopStream(streamFromTracks([video]));
    expect(video.stop).toHaveBeenCalledTimes(1);
  });
});

function fakeTrack(kind: "audio" | "video") {
  return { kind, stop: vi.fn() } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

function fakeStream(tracks: readonly MediaStreamTrack[]): MediaStream {
  return { getTracks: () => [...tracks], getVideoTracks: () => tracks.filter((track) => track.kind === "video") } as MediaStream;
}
