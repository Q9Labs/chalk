import { describe, expect, it, vi } from "vitest";

import { createFakeMediaStreamTrack } from "./fake-media-track";

describe("createFakeMediaStreamTrack", () => {
  it("creates a live video track with stable default state", () => {
    const track = createFakeMediaStreamTrack();

    expect(track).toMatchObject({ kind: "video", id: "video-track", label: "fake", enabled: true, muted: false, readyState: "live", contentHint: "" });
  });

  it("accepts custom kind, identity, mute, and ready state options", () => {
    const track = createFakeMediaStreamTrack({ kind: "audio", id: "microphone", muted: true, readyState: "ended" });

    expect(track).toMatchObject({ kind: "audio", id: "microphone", muted: true, readyState: "ended" });
  });

  it("dispatches mute, unmute, and ended events with updated state", () => {
    const track = createFakeMediaStreamTrack();
    const onMute = vi.fn();
    const onUnmute = vi.fn();
    const onEnded = vi.fn();
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    track.addEventListener("ended", onEnded);

    track.setMuted(true);
    expect(track.muted).toBe(true);
    expect(onMute).toHaveBeenCalledOnce();

    track.setMuted(false);
    expect(track.muted).toBe(false);
    expect(onUnmute).toHaveBeenCalledOnce();

    track.end();
    expect(track.readyState).toBe("ended");
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it("stops without dispatching an ended event and clones its media state", () => {
    const track = createFakeMediaStreamTrack({ kind: "audio", id: "microphone", muted: true });
    const onEnded = vi.fn();
    track.addEventListener("ended", onEnded);

    track.stop();

    expect(track.readyState).toBe("ended");
    expect(onEnded).not.toHaveBeenCalled();

    const clone = track.clone();
    expect(clone).not.toBe(track);
    expect(clone).toMatchObject({ kind: "audio", id: "microphone-clone", muted: true, readyState: "ended", enabled: true });
  });
});
