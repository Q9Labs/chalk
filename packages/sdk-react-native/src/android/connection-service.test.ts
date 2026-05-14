import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = {
  addListener: vi.fn(),
  endCall: vi.fn(async () => true),
  isSupported: vi.fn(async () => true),
  registerPhoneAccount: vi.fn(async () => true),
  removeListeners: vi.fn(),
  setActive: vi.fn(async () => true),
  startCall: vi.fn(async () => true),
};

const subscriptions = new Map<string, (payload: unknown) => void>();
const platform = { OS: "android" };

class MockNativeEventEmitter {
  addListener(eventName: string, listener: (payload: unknown) => void) {
    subscriptions.set(eventName, listener);
    return {
      remove: () => {
        subscriptions.delete(eventName);
      },
    };
  }
}

vi.mock("react-native", () => ({
  NativeEventEmitter: MockNativeEventEmitter,
  NativeModules: {
    ChalkAndroidConnectionService: nativeModule,
  },
  Platform: platform,
}));

describe("android connection service bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    subscriptions.clear();
    platform.OS = "android";
  });

  it("no-ops when Android native support is unavailable", async () => {
    platform.OS = "ios";

    const { addAndroidConnectionServiceListener, ensureAndroidConnectionServiceRegistered, endAndroidConnectionServiceCall, isAndroidConnectionServiceSupported, setAndroidConnectionServiceActive, startAndroidConnectionServiceCall } = await import("./connection-service");

    expect(await isAndroidConnectionServiceSupported()).toBe(false);
    expect(await ensureAndroidConnectionServiceRegistered()).toBe(false);
    expect(
      await startAndroidConnectionServiceCall({
        callId: "room-1:1",
        displayName: "Host",
        roomId: "room-1",
        roomName: "Daily Standup",
      }),
    ).toBe(false);
    expect(await setAndroidConnectionServiceActive("room-1:1")).toBe(false);
    expect(await endAndroidConnectionServiceCall("room-1:1")).toBe(false);

    const unsubscribe = addAndroidConnectionServiceListener(() => {
      throw new Error("listener should not be called on iOS");
    });
    unsubscribe();

    expect(nativeModule.isSupported).not.toHaveBeenCalled();
    expect(nativeModule.registerPhoneAccount).not.toHaveBeenCalled();
    expect(nativeModule.startCall).not.toHaveBeenCalled();
    expect(nativeModule.setActive).not.toHaveBeenCalled();
    expect(nativeModule.endCall).not.toHaveBeenCalled();
  });

  it("passes through Android native module calls and emits disconnect events", async () => {
    const { addAndroidConnectionServiceListener, ensureAndroidConnectionServiceRegistered, endAndroidConnectionServiceCall, isAndroidConnectionServiceSupported, setAndroidConnectionServiceActive, startAndroidConnectionServiceCall } = await import("./connection-service");

    expect(await isAndroidConnectionServiceSupported()).toBe(true);
    expect(await ensureAndroidConnectionServiceRegistered()).toBe(true);
    expect(
      await startAndroidConnectionServiceCall({
        callId: "room-1:2",
        displayName: "Guest",
        hasVideo: false,
        roomId: "room-1",
        roomName: "Board Review",
      }),
    ).toBe(true);
    expect(await setAndroidConnectionServiceActive("room-1:2")).toBe(true);
    expect(await endAndroidConnectionServiceCall("room-1:2", { reason: "remote", label: "Meeting ended" })).toBe(true);

    const listener = vi.fn();
    const unsubscribe = addAndroidConnectionServiceListener(listener);
    const disconnectPayload = {
      callId: "room-1:2",
      reason: "local",
      type: "disconnect",
    };

    subscriptions.get("ChalkAndroidConnectionServiceEvent")?.(disconnectPayload);
    unsubscribe();

    expect(nativeModule.isSupported).toHaveBeenCalledTimes(1);
    expect(nativeModule.registerPhoneAccount).toHaveBeenCalledTimes(1);
    expect(nativeModule.startCall).toHaveBeenCalledWith({
      callId: "room-1:2",
      displayName: "Guest",
      hasVideo: false,
      roomId: "room-1",
      roomName: "Board Review",
    });
    expect(nativeModule.setActive).toHaveBeenCalledWith("room-1:2");
    expect(nativeModule.endCall).toHaveBeenCalledWith("room-1:2", "remote", "Meeting ended");
    expect(listener).toHaveBeenCalledWith(disconnectPayload);
  });
});
