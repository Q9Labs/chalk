import { describe, expect, it } from "vitest";

import { PREVIEW_DEVICE_FIXTURES, createPreviewMediaDevices } from "./preview-devices";

describe("preview media devices", () => {
  it("provides stable microphone, camera, and speaker fixtures", () => {
    expect(PREVIEW_DEVICE_FIXTURES).toEqual({
      microphones: [
        { deviceId: "preview-microphone", label: "Preview microphone" },
        { deviceId: "preview-microphone-backup", label: "Preview microphone · backup" },
      ],
      cameras: [
        { deviceId: "preview-camera", label: "Preview camera" },
        { deviceId: "preview-camera-wide", label: "Preview camera · wide" },
      ],
      speakers: [
        { deviceId: "preview-speaker", label: "Preview speaker" },
        { deviceId: "preview-speaker-headphones", label: "Preview speaker · headphones" },
      ],
    });
    expect(Object.isFrozen(PREVIEW_DEVICE_FIXTURES)).toBe(true);
    expect(Object.isFrozen(PREVIEW_DEVICE_FIXTURES.microphones)).toBe(true);
  });

  it("returns independent copies for preview clients", () => {
    const first = createPreviewMediaDevices();
    const second = createPreviewMediaDevices();

    expect(first).not.toBe(second);
    expect(first.microphones).not.toBe(second.microphones);
    expect(first.microphones[0]).not.toBe(second.microphones[0]);
    expect(first).toEqual(second);
    expect(first.microphones[0]).toEqual(PREVIEW_DEVICE_FIXTURES.microphones[0]);
  });
});
