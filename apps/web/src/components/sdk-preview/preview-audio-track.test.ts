import { afterEach, describe, expect, it, vi } from "vitest";

import { createPreviewAudioTrack } from "./preview-audio-track";

function installAudioContext(audioTracks: readonly object[]) {
  const close = vi.fn(() => Promise.resolve());
  const getAudioTracks = vi.fn(() => audioTracks);
  const createMediaStreamDestination = vi.fn(() => ({ stream: { getAudioTracks } }));
  const AudioContextMock = vi.fn(function createAudioContext() {
    return { close, createMediaStreamDestination };
  });

  vi.stubGlobal("window", {});
  vi.stubGlobal("AudioContext", AudioContextMock);

  return { AudioContextMock, close, createMediaStreamDestination, getAudioTracks };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createPreviewAudioTrack", () => {
  it("closes the AudioContext and falls back when the destination has no track", () => {
    const { AudioContextMock, close, createMediaStreamDestination, getAudioTracks } = installAudioContext([]);

    expect(createPreviewAudioTrack()).toBeNull();
    expect(AudioContextMock).toHaveBeenCalledOnce();
    expect(createMediaStreamDestination).toHaveBeenCalledOnce();
    expect(getAudioTracks).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops the destination track and closes the AudioContext", () => {
    const track = { stop: vi.fn() };
    const { close } = installAudioContext([track]);

    const preview = createPreviewAudioTrack();
    if (!preview) throw new Error("Expected an audio preview track");

    expect(preview.track).toBe(track);
    expect(close).not.toHaveBeenCalled();

    preview.stop();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
