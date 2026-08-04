import { describe, expect, it, vi } from "vitest";
import { SpaceCallKitController, type SpaceCallKitPort, type SpaceCallKitSyncInput } from "./native-space-callkit-controller";

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "ios" },
}));

function createInput(overrides: Partial<SpaceCallKitSyncInput> = {}): SpaceCallKitSyncInput {
  return {
    callKit: true,
    hasVideo: true,
    isAudioEnabled: true,
    joinNonce: 1,
    onEndCall: vi.fn(),
    onToggleAudio: vi.fn(async () => false),
    phase: "joining",
    spaceId: "space-1",
    spaceName: "Daily Standup",
    ...overrides,
  };
}

describe("SpaceCallKitController", () => {
  it("configures, starts, reports, handles mute actions, and ends the native call", async () => {
    let eventListener: Parameters<SpaceCallKitPort["addListener"]>[0] | undefined;
    const removeListener = vi.fn();
    const port: SpaceCallKitPort = {
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
    const controller = new SpaceCallKitController(port);
    const input = createInput();

    controller.start();
    controller.sync(input);
    await Promise.resolve();
    expect(port.configure).toHaveBeenCalledOnce();
    expect(port.startCall).toHaveBeenCalledOnce();

    controller.sync({ ...input, phase: "live" });
    await Promise.resolve();
    expect(port.reportConnected).toHaveBeenCalledWith({ callUUID: "call-1" });

    eventListener?.({ callUUID: "call-1", muted: true, type: "setMutedCallAction" });
    expect(input.onToggleAudio).toHaveBeenCalledOnce();

    controller.sync({ ...input, phase: "entrance" });
    await Promise.resolve();
    expect(port.endCall).toHaveBeenCalledWith({ callUUID: "call-1" });

    controller.stop();
    expect(removeListener).toHaveBeenCalledOnce();
  });
});
