import { describe, expect, it, vi } from "vitest";
import { attachRoomToManagersAndBridgeState } from "../session/chalk-session-bridges";
import { createDefaultMediaState, createSessionStateApis } from "../session/chalk-session-state";

describe("attachRoomToManagersAndBridgeState", () => {
  it("syncs computed media support into session state after room attachment", async () => {
    const syncedMediaState = {
      ...createDefaultMediaState(),
      isBackgroundEffectsSupported: true,
      isVideoEnabled: true,
    };

    const runtime = {
      runPromise: vi.fn(async () => syncedMediaState),
    } as any;

    const room = {
      id: "room_123",
      status: "connected",
      info: { name: "Test Room" },
      participants: new Map(),
      localParticipant: {
        id: "local_123",
        displayName: "Local User",
        isLocal: true,
        videoEnabled: false,
        audioEnabled: true,
        joinedAt: new Date().toISOString(),
      },
      on: vi.fn(() => () => {}),
    } as any;

    const sessionState = createSessionStateApis({
      runtime,
      getCurrentRoom: () => room,
    });

    const attachRoom = vi.fn(() => {});
    const setApiCallbacks = vi.fn(() => {});

    attachRoomToManagersAndBridgeState({
      room,
      setCurrentRoom: vi.fn(() => {}),
      roomApi: sessionState.room,
      participantsApi: sessionState.participants,
      mediaApi: sessionState.media,
      stateUpdaters: sessionState.updaters,
      runtime,
      screenShare: { attachRoom } as any,
      chat: { attachRoom } as any,
      recording: { attachRoom, setApiCallbacks } as any,
      interactions: { attachRoom } as any,
      whiteboard: { attachRoom } as any,
      startRecording: async () => "rec_123",
      stopRecording: async () => {},
    });

    expect(sessionState.media.getState().isBackgroundEffectsSupported).toBe(false);

    await Promise.resolve();

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(sessionState.media.getState()).toMatchObject({
      isBackgroundEffectsSupported: true,
      isVideoEnabled: true,
    });
  });
});
