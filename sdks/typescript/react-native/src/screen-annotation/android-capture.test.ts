import type { SpaceClient } from "@q9labsai/chalk-client";
import { expect, it, vi } from "vitest";
import { createNativeAnnotationCapture } from "./android-capture";

const fixture = vi.hoisted(() => {
  const calls: string[] = [];
  const track = { id: "screen" };
  return {
    calls,
    stream: { getVideoTracks: () => [track] },
    annotation: {
      supportsBurnIn: () => false,
      getSnapshot: () => ({ status: "unavailable" }),
      subscribe: () => () => {},
    },
  };
});

vi.mock("@q9labsai/chalk-client", () => ({ screenAnnotationFor: () => fixture.annotation }));
vi.mock("@cloudflare/react-native-webrtc", () => ({ mediaDevices: {} }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Alert: { alert: () => fixture.calls.push("permission prompt") },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
  NativeModules: {
    ChalkAnnotationOverlay: {
      hasPermission: async () => {
        fixture.calls.push("permission check");
        return true;
      },
      protectControls: async () => {
        fixture.calls.push("protect controls");
        return false;
      },
    },
  },
}));
vi.mock("../media/android-screen-capture", () => ({
  captureAndroidScreen: async () => {
    fixture.calls.push("screen capture");
    return fixture.stream;
  },
}));
vi.mock("../media/native-release-track", () => ({ releaseNativeTrack: () => fixture.calls.push("release capture") }));

it("starts ordinary Android screen capture with the server annotation switch off", async () => {
  const capture = createNativeAnnotationCapture();
  const detach = capture.attach({ subscribe: () => () => {} } as unknown as SpaceClient);
  try {
    const stream = await capture.getDisplayMedia();
    expect(stream).toBe(fixture.stream);
    expect(capture.verifiedAnnotationCapture(stream.getVideoTracks()[0]!)).toBeUndefined();
    expect(fixture.calls).toEqual(["screen capture"]);
  } finally {
    detach();
  }
});
