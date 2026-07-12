import { describe, expect, it, vi } from "vitest";
import type { AndroidConnectionServiceControllerDependencies, AndroidConnectionServiceControllerInput } from "./android-connection-service-controller";
import { AndroidConnectionServiceController } from "./android-connection-service-controller";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createInput(overrides: Partial<AndroidConnectionServiceControllerInput> = {}): AndroidConnectionServiceControllerInput {
  return {
    displayName: "Guest",
    enabled: true,
    hasVideo: true,
    joinNonce: 1,
    onDisconnectRequest: vi.fn(),
    phase: "joining",
    roomId: "room-1",
    roomName: "Daily Standup",
    ...overrides,
  };
}

function createDependencies() {
  let listener: Parameters<AndroidConnectionServiceControllerDependencies["addListener"]>[0] | undefined;
  const dependencies: AndroidConnectionServiceControllerDependencies = {
    addListener: vi.fn((nextListener) => {
      listener = nextListener;
      return vi.fn();
    }),
    endCall: vi.fn(async () => true),
    ensureRegistered: vi.fn(async () => true),
    setActive: vi.fn(async () => true),
    startCall: vi.fn(async () => true),
  };
  return { dependencies, getListener: () => listener };
}

describe("AndroidConnectionServiceController", () => {
  it("starts, activates, and filters disconnect events for the current call", async () => {
    const onDisconnectRequest = vi.fn();
    const { dependencies, getListener } = createDependencies();
    const controller = new AndroidConnectionServiceController(createInput({ onDisconnectRequest }), dependencies);
    const unsubscribe = controller.subscribe(() => {});

    expect(dependencies.ensureRegistered).toHaveBeenCalledTimes(1);
    expect(dependencies.startCall).toHaveBeenCalledWith({
      callId: "room-1:1",
      displayName: "Guest",
      hasVideo: true,
      roomId: "room-1",
      roomName: "Daily Standup",
    });

    controller.update(createInput({ onDisconnectRequest, phase: "meeting" }));
    await flushMicrotasks();
    expect(dependencies.setActive).toHaveBeenCalledWith("room-1:1");

    getListener()?.({ callId: "other:1", reason: "remote", type: "disconnect" });
    getListener()?.({ callId: "room-1:1", reason: "remote", type: "disconnect" });
    expect(onDisconnectRequest).toHaveBeenCalledTimes(1);

    controller.update(createInput({ onDisconnectRequest, phase: "lobby" }));
    await flushMicrotasks();
    expect(dependencies.endCall).toHaveBeenCalledWith("room-1:1", { reason: "canceled" });

    unsubscribe();
  });

  it("ends an active call locally and removes the native listener on unsubscribe", () => {
    const { dependencies } = createDependencies();
    const controller = new AndroidConnectionServiceController(createInput(), dependencies);
    const unsubscribe = controller.subscribe(() => {});

    unsubscribe();

    expect(dependencies.endCall).toHaveBeenCalledWith("room-1:1", { reason: "local" });
    expect(dependencies.addListener).toHaveBeenCalledTimes(1);
  });
});
