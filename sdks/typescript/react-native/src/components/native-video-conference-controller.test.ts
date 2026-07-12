import type { RoomState } from "../internal/core";
import { ChalkSession } from "../internal/core";
import { describe, expect, it, vi } from "vitest";
import { NativeVideoConferenceController, type NativeVideoConferenceControllerOptions } from "./native-video-conference-controller";

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "ios" },
}));

function createOptions(overrides: Partial<NativeVideoConferenceControllerOptions> = {}): NativeVideoConferenceControllerOptions {
  return {
    autoJoin: false,
    chatCount: 0,
    initialJoinSettings: undefined,
    initialPhase: undefined,
    participantCount: 0,
    role: "participant",
    roomId: "room-1",
    session: new ChalkSession({ apiUrl: "https://api.example.test" }),
    simulatorMediaDisabled: false,
    telemetry: undefined,
    transcriptCount: 0,
    ...overrides,
  };
}

describe("NativeVideoConferenceController", () => {
  it("starts in the lobby and moves to joining from the user action", () => {
    const controller = new NativeVideoConferenceController(createOptions());

    expect(controller.getSnapshot()).toMatchObject({ phase: "lobby", joinNonce: 0, pendingJoinRequest: false });

    controller.startJoin({ displayName: "  Hasan  ", audioEnabled: true, videoEnabled: true });

    expect(controller.getSnapshot()).toMatchObject({
      phase: "joining",
      joinNonce: 1,
      pendingJoinRequest: true,
      joinSettings: { displayName: "Hasan", audioEnabled: true, videoEnabled: true },
    });
  });

  it("promotes an automatic join when the room connects", async () => {
    let roomState: RoomState = {
      id: null,
      status: "disconnected",
      error: null,
      roomId: null,
      roomName: null,
      isJoining: false,
      hostId: null,
    };
    let roomListener = (): void => {};
    const session = new ChalkSession({ apiUrl: "https://api.example.test" });
    session.room.getState = () => roomState;
    session.room.getRoom = () => roomState;
    session.room.subscribe = (listener: () => void) => {
      roomListener = listener;
      return () => {};
    };
    session.join = async (_roomId, _options) => {
      roomState = { ...roomState, id: "room-1", roomId: "room-1", status: "connected" };
      roomListener();
    };
    const onJoin = vi.fn();
    const controller = new NativeVideoConferenceController(createOptions({ autoJoin: true, onJoin, session }));
    const unsubscribe = controller.subscribe(() => {});

    await Promise.resolve();

    expect(onJoin).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe("meeting");
    unsubscribe();
    await Promise.resolve();
  });
});
