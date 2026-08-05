import { describe, expect, it, vi } from "vitest";
import { MediaDeviceSelection } from "./media-device-selection";

describe("MediaDeviceSelection", () => {
  it("uses selected capture devices in the next capture constraints", async () => {
    const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => ({}) as MediaStream);
    const selection = new MediaDeviceSelection({
      getUserMedia,
      getDisplayMedia: vi.fn(),
    });

    selection.selectCapture("microphone", "microphone-2");
    selection.selectCapture("camera", "camera-3");
    await selection.getUserMedia({ audio: true, video: { width: { ideal: 1280 } } });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "microphone-2" } },
      video: { width: { ideal: 1280 }, deviceId: { exact: "camera-3" } },
    });
  });

  it("only publishes a speaker selection after the provided output seam confirms it", async () => {
    const selectSpeaker = vi.fn(async () => undefined);
    const selection = new MediaDeviceSelection({
      getUserMedia: vi.fn(),
      getDisplayMedia: vi.fn(),
      selectSpeaker,
    });

    await selection.selectSpeaker("speaker-4");

    expect(selectSpeaker).toHaveBeenCalledWith("speaker-4");
  });

  it("rejects speaker selection where no output seam exists", async () => {
    const selection = new MediaDeviceSelection({
      getUserMedia: vi.fn(),
      getDisplayMedia: vi.fn(),
    });

    await expect(selection.selectSpeaker("speaker-4")).rejects.toMatchObject({ code: "environment.unsupported" });
  });
});
