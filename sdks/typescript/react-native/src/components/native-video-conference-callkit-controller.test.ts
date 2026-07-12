import { describe, expect, it, vi } from "vitest";
import { NativeVideoConferenceCallKitController, type NativeVideoConferenceCallKitPort, type NativeVideoConferenceCallKitSyncInput } from "./native-video-conference-callkit-controller";

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "ios" },
}));

function createInput(overrides: Partial<NativeVideoConferenceCallKitSyncInput> = {}): NativeVideoConferenceCallKitSyncInput {
  return {
    callKit: true,
    hasVideo: true,
    isAudioEnabled: true,
    joinNonce: 1,
    onEndCall: vi.fn(),
    onToggleAudio: vi.fn(async () => false),
    phase: "joining",
    roomId: "room-1",
    roomName: "Daily Standup",
    ...overrides,
  };
}

describe("NativeVideoConferenceCallKitController", () => {
  it("configures, starts, reports, handles mute actions, and ends the native call", async () => {
    let eventListener: Parameters<NativeVideoConferenceCallKitPort["addListener"]>[0] | undefined;
    const removeListener = vi.fn();
    const port: NativeVideoConferenceCallKitPort = {
      isSupported: true,
      addListener: vi.fn((listener) => {
        eventListener = listener;
        return { remove: removeListener };
      }),
      configure: vi.fn(async () => ({ isSupported: true })),
      endCall: vi.fn(async () => {}),
      reportConnected: vi.fn(async () => {}),
      startCall: vi.fn(async () => ({ callUUID: "call-1" })),
    };
    const controller = new NativeVideoConferenceCallKitController(port);
    const input = createInput();

    controller.start();
    controller.sync(input);
    await Promise.resolve();
    expect(port.configure).toHaveBeenCalledOnce();
    expect(port.startCall).toHaveBeenCalledOnce();

    controller.sync({ ...input, phase: "meeting" });
    await Promise.resolve();
    expect(port.reportConnected).toHaveBeenCalledWith({ callUUID: "call-1" });

    eventListener?.({ callUUID: "call-1", muted: true, type: "setMutedCallAction" });
    expect(input.onToggleAudio).toHaveBeenCalledOnce();

    controller.sync({ ...input, phase: "lobby" });
    await Promise.resolve();
    expect(port.endCall).toHaveBeenCalledWith({ callUUID: "call-1" });

    controller.stop();
    expect(removeListener).toHaveBeenCalledOnce();
  });
});
