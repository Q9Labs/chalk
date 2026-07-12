import { describe, expect, it, vi } from "vitest";
import type { NativeMediaStream, NativeMediaStreamTrack } from "../media/realtimekit/native-webrtc";
import { createPreJoinPreviewStore } from "./pre-join-preview-store";

function createStream(withVideoTrack: boolean): { stream: NativeMediaStream; wasStopped: () => boolean } {
  let stopped = false;
  const track: NativeMediaStreamTrack = {
    id: "camera-track",
    kind: "video",
    enabled: true,
    muted: false,
    readyState: "live",
    stop: () => {
      stopped = true;
    },
  };
  const stream: NativeMediaStream = {
    toURL: () => "camera-stream",
    getTracks: () => (withVideoTrack ? [track] : []),
    getVideoTracks: () => (withVideoTrack ? [track] : []),
    getAudioTracks: () => [],
  };

  return { stream, wasStopped: () => stopped };
}

describe("createPreJoinPreviewStore", () => {
  it("starts the camera on subscription and stops it on cleanup", async () => {
    const camera = createStream(true);
    const getUserMedia = vi.fn(async () => camera.stream);
    const store = createPreJoinPreviewStore({
      enabled: true,
      simulatorVideoDisabled: false,
      simulatorVideoMessage: "simulator",
      getUserMedia,
    });

    const unsubscribe = store.subscribe(() => {});
    await Promise.resolve();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: "user" } });
    expect(store.getSnapshot()).toEqual({ previewStream: camera.stream, previewError: null });

    unsubscribe();
    expect(camera.wasStopped()).toBe(true);
  });

  it("reports simulator video as unavailable without opening the camera", () => {
    const getUserMedia = vi.fn(async () => createStream(true).stream);
    const store = createPreJoinPreviewStore({
      enabled: true,
      simulatorVideoDisabled: true,
      simulatorVideoMessage: "Video is unavailable in the iOS simulator",
      getUserMedia,
    });

    const unsubscribe = store.subscribe(() => {});

    expect(store.getSnapshot()).toEqual({ previewStream: null, previewError: "Video is unavailable in the iOS simulator" });
    expect(getUserMedia).not.toHaveBeenCalled();
    unsubscribe();
  });
});
