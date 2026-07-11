import { beforeEach, describe, expect, it, vi } from "vitest";

const addListener = vi.fn();
const configure = vi.fn(async () => ({ isSupported: true }));
const endAllCalls = vi.fn(async () => undefined);
const endCall = vi.fn(async () => undefined);
const reportConnected = vi.fn(async () => undefined);
const reportIncomingCall = vi.fn(async () => ({ callUUID: "incoming-uuid" }));
const startCall = vi.fn(async () => ({ callUUID: "outgoing-uuid" }));
const updateCall = vi.fn(async () => undefined);

const nativeModule = {
  configure,
  endAllCalls,
  endCall,
  eventName: "ChalkCallKitEvent",
  isSupported: true,
  reportConnected,
  reportIncomingCall,
  startCall,
  updateCall,
};

const eventEmitter = {
  addListener,
};

const platform = { OS: "ios" };
const nativeModules = { ChalkCallKitModule: nativeModule };

vi.mock("react-native", () => ({
  NativeEventEmitter: class {
    constructor() {
      return eventEmitter;
    }
  },
  NativeModules: nativeModules,
  Platform: platform,
}));

describe("nativeCallKit", () => {
  beforeEach(() => {
    vi.resetModules();
    platform.OS = "ios";
    nativeModule.isSupported = true;
    addListener.mockReset();
    configure.mockClear();
    endAllCalls.mockClear();
    endCall.mockClear();
    reportConnected.mockClear();
    reportIncomingCall.mockClear();
    startCall.mockClear();
    updateCall.mockClear();
  });

  it("uses the native event emitter when the iOS module is available", async () => {
    const listener = vi.fn();
    addListener.mockReturnValueOnce({ remove: vi.fn() });

    const { nativeCallKit } = await import("./native-callkit");
    const subscription = nativeCallKit.addListener(listener);

    expect(nativeCallKit.isSupported).toBe(true);
    expect(addListener).toHaveBeenCalledWith("ChalkCallKitEvent", listener);
    expect(subscription.remove).toBeTypeOf("function");
  });

  it("falls back to no-op behavior on unsupported platforms", async () => {
    platform.OS = "android";

    const { nativeCallKit } = await import("./native-callkit");
    const result = await nativeCallKit.startCall({
      displayName: "Room",
      handle: "room-123",
    });

    expect(nativeCallKit.isSupported).toBe(false);
    expect(result).toBeNull();
    expect(startCall).not.toHaveBeenCalled();
  });

  it("passes configuration through to the native bridge", async () => {
    const { nativeCallKit } = await import("./native-callkit");

    await nativeCallKit.configure({
      appName: "Chalk",
      includesCallsInRecents: false,
    });

    expect(configure).toHaveBeenCalledWith({
      appName: "Chalk",
      includesCallsInRecents: false,
    });
  });
});
