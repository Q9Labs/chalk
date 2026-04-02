import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModules = {
  ChalkRuntimeInfo: { isSimulator: true },
  WebRTCModule: {
    receiverGetCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
    senderGetCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
  },
};

const realtimeKitModule = {
  init: vi.fn(async (config: unknown) => config),
  initMedia: vi.fn(async () => ({ shouldNotBeUsed: true })),
};

vi.mock("react-native", () => ({
  NativeModules: nativeModules,
  Platform: { OS: "ios" },
}));

vi.mock("@cloudflare/react-native-webrtc", () => ({
  RTCRtpReceiver: {
    getCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
  },
  RTCRtpSender: {
    getCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
  },
  mediaDevices: {
    enumerateDevices: vi.fn(async () => [{ kind: "videoinput", deviceId: "camera-1" }]),
  },
}));

vi.mock("@cloudflare/realtimekit-react-native", () => ({
  default: realtimeKitModule,
}));

describe("importReactNativeRealtimeKit", () => {
  beforeEach(() => {
    vi.resetModules();
    realtimeKitModule.init.mockClear();
    realtimeKitModule.initMedia.mockClear();
  });

  it("keeps simulator joins media-off without eagerly initializing local media", async () => {
    const { importReactNativeRealtimeKit } = await import("./realtimekit-loader");

    const realtimeKit = await importReactNativeRealtimeKit();
    const result = await realtimeKit.init({
      defaults: {
        customFlag: true,
      },
    });

    expect(realtimeKitModule.initMedia).not.toHaveBeenCalled();
    expect(realtimeKitModule.init).toHaveBeenCalledWith({
      defaults: {
        customFlag: true,
        audio: false,
        video: false,
      },
    });
    expect(result).toEqual({
      defaults: {
        customFlag: true,
        audio: false,
        video: false,
      },
    });
  });
});
