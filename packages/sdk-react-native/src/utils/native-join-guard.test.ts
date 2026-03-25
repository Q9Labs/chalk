import { describe, expect, it } from "bun:test";
import { canExecuteNativeJoin, canStartNativeJoin, shouldPromoteAfterJoinError } from "./native-join-guard";

describe("canStartNativeJoin", () => {
  it("allows a fresh lobby join", () => {
    expect(canStartNativeJoin("lobby", false, false, false)).toBe(true);
  });

  it("blocks duplicate or stale join attempts", () => {
    expect(canStartNativeJoin("joining", false, false, false)).toBe(false);
    expect(canStartNativeJoin("lobby", true, false, false)).toBe(false);
    expect(canStartNativeJoin("lobby", false, true, false)).toBe(false);
    expect(canStartNativeJoin("lobby", false, false, true)).toBe(false);
  });
});

describe("canExecuteNativeJoin", () => {
  it("allows the first join execution for a pending join nonce", () => {
    expect(canExecuteNativeJoin("joining", 1, false, false, true, null)).toBe(true);
  });

  it("blocks reruns once the same join nonce is already executing or the room state advanced", () => {
    expect(canExecuteNativeJoin("joining", 1, false, false, true, 1)).toBe(false);
    expect(canExecuteNativeJoin("joining", 1, true, false, true, null)).toBe(false);
    expect(canExecuteNativeJoin("joining", 1, false, true, true, null)).toBe(false);
    expect(canExecuteNativeJoin("joining", 0, false, false, true, null)).toBe(false);
    expect(canExecuteNativeJoin("lobby", 1, false, false, true, null)).toBe(false);
  });
});

describe("shouldPromoteAfterJoinError", () => {
  it("treats duplicate same-room joins as success once the room is already connected", () => {
    expect(
      shouldPromoteAfterJoinError({
        error: new Error("Already connected to a room"),
        expectedRoomId: "room_123",
        activeRoomId: "room_123",
        roomStateRoomId: "room_123",
        roomStatus: "connected",
      }),
    ).toBe(true);
  });

  it("does not hide actual failures or mismatched-room state", () => {
    expect(
      shouldPromoteAfterJoinError({
        error: new Error("Already connected to a room"),
        expectedRoomId: "room_123",
        activeRoomId: "room_456",
        roomStateRoomId: "room_456",
        roomStatus: "connected",
      }),
    ).toBe(false);
    expect(
      shouldPromoteAfterJoinError({
        error: new Error("Unable to join room"),
        expectedRoomId: "room_123",
        activeRoomId: "room_123",
        roomStateRoomId: "room_123",
        roomStatus: "connected",
      }),
    ).toBe(false);
    expect(
      shouldPromoteAfterJoinError({
        error: new Error("Already connected to a room"),
        expectedRoomId: "room_123",
        activeRoomId: "room_123",
        roomStateRoomId: "room_123",
        roomStatus: "connecting",
      }),
    ).toBe(false);
  });
});
