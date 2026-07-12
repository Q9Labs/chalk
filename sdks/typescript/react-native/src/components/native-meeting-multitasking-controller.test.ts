import { describe, expect, it, vi } from "vitest";
import type { NativeMeetingMultitaskingAppState, NativeMeetingMultitaskingConfig, NativeMeetingMultitaskingModule } from "./native-meeting-multitasking-controller";
import { NativeMeetingMultitaskingController } from "./native-meeting-multitasking-controller";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createConfig(roomName = "Daily Standup"): NativeMeetingMultitaskingConfig {
  return {
    cameraOff: false,
    muted: false,
    participantName: "Guest",
    roomName,
    streamURL: null,
  };
}

function createModule() {
  const module: NativeMeetingMultitaskingModule = {
    setPictureInPictureEnabled: vi.fn(async () => {}),
    updatePictureInPictureConfig: vi.fn(async () => {}),
    startPictureInPicture: vi.fn(async () => {}),
    stopPictureInPicture: vi.fn(async () => {}),
    startBackgroundMode: vi.fn(async () => {}),
    stopBackgroundMode: vi.fn(async () => {}),
  };
  return module;
}

describe("NativeMeetingMultitaskingController", () => {
  it("updates Android background state and starts PiP when the app backgrounds", async () => {
    let listener: ((nextState: string) => void) | undefined;
    const appState: NativeMeetingMultitaskingAppState = {
      currentState: "active",
      addEventListener: vi.fn((nextListener) => {
        listener = nextListener;
        return { remove: vi.fn() };
      }),
    };
    const module = createModule();
    const reportFailure = vi.fn();
    const controller = new NativeMeetingMultitaskingController({ platform: "android", appState, module, reportFailure });

    controller.update(createConfig());
    const unsubscribe = controller.subscribe(() => {});
    await flushMicrotasks();

    expect(module.setPictureInPictureEnabled).toHaveBeenCalledWith(true);
    expect(module.updatePictureInPictureConfig).toHaveBeenCalledWith(createConfig());
    expect(module.startBackgroundMode).toHaveBeenCalledWith(createConfig());

    listener?.("background");
    expect(module.startPictureInPicture).toHaveBeenCalledTimes(1);

    controller.update(createConfig("Board Review"));
    await flushMicrotasks();
    expect(module.updatePictureInPictureConfig).toHaveBeenLastCalledWith(createConfig("Board Review"));
    expect(module.startBackgroundMode).toHaveBeenLastCalledWith(createConfig("Board Review"));

    unsubscribe();
    await flushMicrotasks();
    expect(module.setPictureInPictureEnabled).toHaveBeenLastCalledWith(false);
    expect(module.stopPictureInPicture).toHaveBeenCalledTimes(1);
    expect(module.stopBackgroundMode).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("keeps iOS cleanup platform-specific", async () => {
    const remove = vi.fn();
    const appState: NativeMeetingMultitaskingAppState = {
      currentState: "active",
      addEventListener: vi.fn(() => ({ remove })),
    };
    const module = createModule();
    const controller = new NativeMeetingMultitaskingController({ platform: "ios", appState, module, reportFailure: vi.fn() });

    controller.update(createConfig());
    const unsubscribe = controller.subscribe(() => {});
    unsubscribe();
    await flushMicrotasks();

    expect(module.startBackgroundMode).not.toHaveBeenCalled();
    expect(module.stopBackgroundMode).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
