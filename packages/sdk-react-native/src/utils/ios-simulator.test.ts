import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModules = {
  ChalkRuntimeInfo: { isSimulator: true },
  WebRTCModule: {
    receiverGetCapabilities: vi.fn(() => {
      throw new Error("native receiver call should be bypassed on simulator");
    }),
    senderGetCapabilities: vi.fn(() => {
      throw new Error("native sender call should be bypassed on simulator");
    }),
  },
};

const mockedMediaDevices = {
  enumerateDevices: vi.fn(async () => {
    throw new Error("mediaDevices.enumerateDevices should be bypassed on simulator");
  }),
};

vi.mock("react-native", () => ({
  NativeModules: nativeModules,
  Platform: { OS: "ios" },
}));

describe("ensureIosSimulatorWebRtcSafety", () => {
  beforeEach(() => {
    vi.resetModules();
    nativeModules.ChalkRuntimeInfo.isSimulator = true;
    nativeModules.WebRTCModule.receiverGetCapabilities = vi.fn(() => {
      throw new Error("native receiver call should be bypassed on simulator");
    });
    nativeModules.WebRTCModule.senderGetCapabilities = vi.fn(() => {
      throw new Error("native sender call should be bypassed on simulator");
    });
    delete (globalThis as Record<string, unknown>).RTCRtpReceiver;
    delete (globalThis as Record<string, unknown>).RTCRtpSender;
    mockedMediaDevices.enumerateDevices = vi.fn(async () => {
      throw new Error("mediaDevices.enumerateDevices should be bypassed on simulator");
    });
  });

  it("patches native capability lookups on the iOS simulator", async () => {
    const { ensureIosSimulatorWebRtcSafety } = await import("./ios-simulator");

    ensureIosSimulatorWebRtcSafety();

    expect(nativeModules.WebRTCModule.receiverGetCapabilities("video")).toEqual({
      codecs: [],
      headerExtensions: [],
    });
    expect(nativeModules.WebRTCModule.senderGetCapabilities("audio")).toEqual({
      codecs: [],
      headerExtensions: [],
    });
  });

  it("patches exported RTCRtp capability helpers when available", async () => {
    const { ensureIosSimulatorWebRtcSafety } = await import("./ios-simulator");

    const receiver = {
      getCapabilities: vi.fn(() => {
        throw new Error("receiver helper should be patched");
      }),
    };
    const sender = {
      getCapabilities: vi.fn(() => {
        throw new Error("sender helper should be patched");
      }),
    };

    ensureIosSimulatorWebRtcSafety({
      RTCRtpReceiver: receiver,
      RTCRtpSender: sender,
    });

    expect(receiver.getCapabilities("video")).toEqual({
      codecs: [],
      headerExtensions: [],
    });
    expect(sender.getCapabilities("audio")).toEqual({
      codecs: [],
      headerExtensions: [],
    });
  });

  it("patches media device enumeration on the iOS simulator", async () => {
    const { ensureIosSimulatorWebRtcSafety } = await import("./ios-simulator");

    ensureIosSimulatorWebRtcSafety({
      mediaDevices: mockedMediaDevices,
    });

    await expect(mockedMediaDevices.enumerateDevices()).resolves.toEqual([]);
  });
});
