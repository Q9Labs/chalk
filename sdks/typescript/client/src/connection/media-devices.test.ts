import { describe, expect, it, vi } from "vitest";
import { recordDeviceFailure } from "../media/capture-error";
import { createBrowserMediaDevices } from "./media-devices";

function fakeBrowser() {
  const denied = () => new DOMException("Permission denied", "NotAllowedError");
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints): Promise<MediaStream> => {
    throw denied();
  });
  const status = Object.assign(new EventTarget(), { state: "denied" });
  const permissions = { query: vi.fn(async () => status) };
  const devices = createBrowserMediaDevices({ getUserMedia } as unknown as MediaDevices, permissions);
  return { devices, getUserMedia, status, permissions };
}

describe("browser media devices after a refusal", () => {
  it("answers a repeated request for a refused microphone without asking the browser", async () => {
    const { devices, getUserMedia } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true, video: false })).rejects.toMatchObject({ name: "NotAllowedError" });
    for (let attempt = 0; attempt < 5; attempt++) await expect(devices.getUserMedia({ audio: true, video: false })).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("asks the browser again once its permission changes", async () => {
    const { devices, getUserMedia, status } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    status.dispatchEvent(new Event("change"));
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("asks the browser again after the person acts", async () => {
    const { devices, getUserMedia } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    devices.allowRetry?.();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("keeps the camera available while the microphone is refused", async () => {
    const { devices, getUserMedia } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream);
    await expect(devices.getUserMedia({ audio: false, video: true })).resolves.toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not mark a device from a refused request for both, which names no device", async () => {
    const { devices, getUserMedia } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true, video: true })).rejects.toThrow();
    await expect(devices.getUserMedia({ audio: true, video: false })).rejects.toThrow();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("records the refusal once, not each time it is repeated", async () => {
    const { devices } = fakeBrowser();
    const record = vi.fn();
    for (let attempt = 0; attempt < 4; attempt++) await devices.getUserMedia({ audio: true }).catch((cause: unknown) => recordDeviceFailure({ record }, cause, "microphone"));
    expect(record).toHaveBeenCalledTimes(1);
  });
});
