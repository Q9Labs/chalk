import { beforeEach, describe, expect, it, vi } from "vitest";

const addListener = vi.fn();
const configure = vi.fn(async () => ({ isSupported: true }));
const endCall = vi.fn(async () => undefined);
const reportConnected = vi.fn(async () => undefined);
const startCall = vi.fn(async () => ({ callUUID: "outgoing-uuid" }));

const nativeModule = {
  configure,
  endCall,
  eventName: "ChalkCallKitEvent",
  isSupported: true,
  reportConnected,
  startCall,
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

describe("callKit", () => {
  beforeEach(() => {
    vi.resetModules();
    platform.OS = "ios";
    nativeModule.isSupported = true;
    addListener.mockReset();
    configure.mockClear();
    endCall.mockClear();
    reportConnected.mockClear();
    startCall.mockClear();
  });

  it("uses the native event emitter when the iOS module is available", async () => {
    const listener = vi.fn();
    addListener.mockReturnValueOnce({ remove: vi.fn() });

    const { callKit } = await import("./callkit");
    const subscription = callKit.addListener(listener);

    expect(callKit.isSupported).toBe(true);
    expect(addListener).toHaveBeenCalledWith("ChalkCallKitEvent", listener);
    expect(subscription.remove).toBeTypeOf("function");
  });

  it("falls back to no-op behavior on unsupported platforms", async () => {
    platform.OS = "android";

    const { callKit } = await import("./callkit");
    const result = await callKit.startCall({
      displayName: "Space",
      handle: "space-123",
    });

    expect(callKit.isSupported).toBe(false);
    expect(result).toBeNull();
    expect(startCall).not.toHaveBeenCalled();
  });

  it("forwards controller-facing calls and preserves native failures", async () => {
    const { callKit } = await import("./callkit");
    const callOptions = { callUUID: "call-uuid", displayName: "Space", handle: "space-123", hasVideo: true };

    await callKit.configure({
      appName: "Chalk",
      includesCallsInRecents: false,
    });
    await expect(callKit.startCall(callOptions)).resolves.toEqual({ callUUID: "outgoing-uuid" });
    await callKit.reportConnected({ callUUID: "outgoing-uuid" });
    await callKit.endCall({ callUUID: "outgoing-uuid", reason: "remoteEnded" });

    expect(configure).toHaveBeenCalledWith({
      appName: "Chalk",
      includesCallsInRecents: false,
    });
    expect(startCall).toHaveBeenCalledWith(callOptions);
    expect(reportConnected).toHaveBeenCalledWith({ callUUID: "outgoing-uuid" });
    expect(endCall).toHaveBeenCalledWith({ callUUID: "outgoing-uuid", reason: "remoteEnded" });

    const nativeFailure = new Error("CallKit unavailable");
    startCall.mockRejectedValueOnce(nativeFailure);
    await expect(callKit.startCall(callOptions)).rejects.toBe(nativeFailure);
  });
});
