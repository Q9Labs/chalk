import { createSpaceClient } from "@q9labsai/chalk-client";
import { expect, it, vi } from "vitest";
import { createNativeAnnotationCapture } from "./android-capture";

const nativeEvents = vi.hoisted((): string[] => []);

vi.mock("@cloudflare/react-native-webrtc", () => ({
  MediaStreamTrack: class {
    readonly id: string;
    readyState = "live";

    constructor({ id }: { readonly id: string }) {
      this.id = id;
    }

    stop() {
      this.readyState = "ended";
    }

    release() {
      nativeEvents.push("release capture");
    }
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppRegistry: { registerHeadlessTask() {} },
  Alert: { alert: () => nativeEvents.push("permission prompt") },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
  NativeModules: {
    ChalkScreenCapture: {
      capture: async () => {
        nativeEvents.push("screen capture");
        return { id: "screen" };
      },
    },
    ChalkAnnotationOverlay: {
      hasPermission: async () => {
        nativeEvents.push("permission check");
        return true;
      },
      protectControls: async () => {
        nativeEvents.push("protect controls");
        return false;
      },
    },
  },
}));

it("captures and releases a plain Android screen when annotation has not been enabled", async () => {
  const client = createSpaceClient({
    space: "plain-screen-share",
    baseUrl: "http://127.0.0.1:1",
    getAccess: async () => {
      throw new Error("Starting local capture should not request network access");
    },
  });
  const capture = createNativeAnnotationCapture();
  const detach = capture.attach(client);
  try {
    const stream = await capture.getDisplayMedia();
    const [track] = stream.getVideoTracks();
    expect(track?.id).toBe("screen");
    expect(capture.verifiedAnnotationCapture(track!)).toBeUndefined();

    capture.releaseTrack(track!);
    expect(track?.readyState).toBe("ended");
    expect(nativeEvents).toEqual(["screen capture", "release capture"]);
  } finally {
    detach();
    client.dispose();
  }
});
