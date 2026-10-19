import { describe, expect, it } from "vitest";
import { nextCamera } from "./next-camera";

const devices = [
  { deviceId: "front", label: "Front camera", kind: "videoinput" },
  { deviceId: "wide", label: "Front wide camera", kind: "videoinput" },
  { deviceId: "rear", label: "Back camera", kind: "videoinput" },
] as const;

describe("phone camera selection", () => {
  it("prefers the opposite facing camera over the next lens", () => {
    expect(nextCamera(devices, "front")?.deviceId).toBe("rear");
    expect(nextCamera(devices, "rear")?.deviceId).toBe("front");
  });
  it("uses the selected camera even when its track is off", () => {
    expect(nextCamera(devices, "wide", null)?.deviceId).toBe("rear");
  });
  it("cycles unlabelled cameras and wraps", () => {
    const unlabelled = devices.map((device) => ({ ...device, label: "" }));
    expect(nextCamera(unlabelled, "front")?.deviceId).toBe("wide");
    expect(nextCamera(unlabelled, "rear")?.deviceId).toBe("front");
  });
  it("uses the track's facing capability when its label is unavailable", () => {
    const cameras = [{ ...devices[0], label: "Camera 1" }, devices[1], devices[2]];
    expect(nextCamera(cameras, "front", { getSettings: () => ({}), getCapabilities: () => ({ facingMode: ["user"] }) })?.deviceId).toBe("rear");
  });
  it("uses track settings to identify the current camera", () => {
    expect(nextCamera(devices, undefined, { getSettings: () => ({ deviceId: "front", facingMode: "user" }), getCapabilities: () => ({}) })?.deviceId).toBe("rear");
  });
  it("handles missing selections and empty device lists", () => {
    expect(nextCamera(devices, "removed")?.deviceId).toBe("front");
    expect(nextCamera([], "removed")).toBeUndefined();
  });
});
