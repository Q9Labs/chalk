import { describe, expect, it, vi } from "vitest";
import { createBrowserMediaDevices, displayMediaConstraints, screenShareCapture } from "./media-devices";

describe("screen capture picker hints", () => {
  it.each(["monitor", "window", "browser"] as const)("passes the %s hint to the browser", async (surface) => {
    const getDisplayMedia = vi.fn<MediaDevices["getDisplayMedia"]>().mockResolvedValue({} as MediaStream);
    const devices = createBrowserMediaDevices({ getDisplayMedia } as MediaDevices);
    await devices.getDisplayMedia(displayMediaConstraints({ surface }));
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: { displaySurface: surface }, audio: false, selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "exclude" });
  });

  it("requests audio only when requested", () => {
    expect(displayMediaConstraints()).toMatchObject({ video: true, audio: false });
    expect(displayMediaConstraints({ surface: "browser", audio: true })).toMatchObject({ audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: "exclude" });
  });

  it("reports the actual selected surface, even when the hint was ignored", () => {
    const track = { label: "Slides", getSettings: () => ({ displaySurface: "window" }) } as MediaStreamTrack;
    expect(screenShareCapture(track)).toEqual({ surface: "window", label: "Slides" });
    expect(screenShareCapture({ label: "", getSettings: () => ({}) } as MediaStreamTrack)).toEqual({ surface: null, label: null });
  });
});
