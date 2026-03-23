import { describe, expect, it } from "bun:test";
import { getCanonicalJoinRoomId, getJoinRoomName } from "./join-exchange";

describe("join exchange helpers", () => {
  it("requires the canonical room id from join-token exchange", () => {
    expect(() => getCanonicalJoinRoomId({ roomName: "Velvet Harbor" })).toThrow("canonical room id");
  });

  it("uses the canonical room id when present", () => {
    expect(getCanonicalJoinRoomId({ roomId: "room_uuid_123", roomName: "Velvet Harbor" })).toBe("room_uuid_123");
  });

  it("humanizes room name while preserving canonical room id", () => {
    expect(getJoinRoomName({ roomId: "room_uuid_123", roomName: "velvet-harbor" })).toBe("Velvet Harbor");
  });
});
