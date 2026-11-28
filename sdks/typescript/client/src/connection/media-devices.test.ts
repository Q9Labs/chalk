import { describe, expect, it } from "vitest";
import { recordDeviceFailure } from "../media/capture-error";
import { createBrowserMediaDevices } from "./media-devices";

function fakeBrowser() {
  const denied = () => new DOMException("Permission denied", "NotAllowedError");
  const requests: MediaStreamConstraints[] = [];
  const browser = { allowNext: false };
  const getUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    requests.push(constraints);
    if (!browser.allowNext) throw denied();
    browser.allowNext = false;
    return { getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
  };
  const status = Object.assign(new EventTarget(), { state: "denied" });
  const devices = createBrowserMediaDevices({ getUserMedia } as unknown as MediaDevices, { query: async () => status });
  return { devices, requests, browser, status };
}

describe("browser media devices after a refusal", () => {
  it("answers a repeated request for a refused microphone without asking the browser", async () => {
    const { devices, requests } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true, video: false })).rejects.toMatchObject({ name: "NotAllowedError" });
    for (let attempt = 0; attempt < 5; attempt++) await expect(devices.getUserMedia({ audio: true, video: false })).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(requests).toHaveLength(1);
  });

  it("asks the browser again once its permission changes", async () => {
    const { devices, requests, status } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    status.dispatchEvent(new Event("change"));
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("asks the browser again after the person acts", async () => {
    const { devices, requests } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    devices.allowRetry?.();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("keeps the camera available while the microphone is refused", async () => {
    const { devices, requests, browser } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true })).rejects.toThrow();
    browser.allowNext = true;
    await expect(devices.getUserMedia({ audio: false, video: true })).resolves.toBeDefined();
    expect(requests).toHaveLength(2);
  });

  it("does not mark a device from a refused request for both, which names no device", async () => {
    const { devices, requests } = fakeBrowser();
    await expect(devices.getUserMedia({ audio: true, video: true })).rejects.toThrow();
    await expect(devices.getUserMedia({ audio: true, video: false })).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("records the refusal once, not each time it is repeated", async () => {
    const { devices } = fakeBrowser();
    const records: unknown[] = [];
    const telemetry = { record: (event: unknown) => void records.push(event) };
    for (let attempt = 0; attempt < 4; attempt++) await devices.getUserMedia({ audio: true }).catch((cause: unknown) => recordDeviceFailure(telemetry, cause, "microphone"));
    expect(records).toHaveLength(1);
  });
});
