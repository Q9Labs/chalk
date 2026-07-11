import { describe, expect, it } from "vitest";
import { resolveInitialNativeVideoConferencePhase, shouldResumeNativeMeetingPhase } from "./native-video-conference-phase";

describe("native-video-conference-phase", () => {
  it("starts in meeting when the current session is already connected to the same room", () => {
    expect(
      resolveInitialNativeVideoConferencePhase({
        initialPhase: "lobby",
        isConnected: true,
        activeRoomId: "room_123",
        roomId: "room_123",
      }),
    ).toBe("meeting");
  });

  it("keeps the requested initial phase when the connected room does not match", () => {
    expect(
      resolveInitialNativeVideoConferencePhase({
        initialPhase: "lobby",
        isConnected: true,
        activeRoomId: "other_room",
        roomId: "room_123",
      }),
    ).toBe("lobby");
  });

  it("falls back to joining when auto join is enabled", () => {
    expect(
      resolveInitialNativeVideoConferencePhase({
        autoJoin: true,
        isConnected: false,
        activeRoomId: null,
        roomId: "room_123",
      }),
    ).toBe("joining");
  });

  it("identifies when a lobby view should resume into the active meeting", () => {
    expect(
      shouldResumeNativeMeetingPhase({
        isConnected: true,
        activeRoomId: "room_123",
        roomId: "room_123",
      }),
    ).toBe(true);

    expect(
      shouldResumeNativeMeetingPhase({
        isConnected: false,
        activeRoomId: "room_123",
        roomId: "room_123",
      }),
    ).toBe(false);
  });
});
