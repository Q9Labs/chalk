import { describe, expect, it, vi } from "vitest";

vi.mock("./MeetingRoom.shared", () => ({ MeetingRoomShared: () => null }));

describe("MeetingRoom.ios-pad", () => {
  it("exposes the canonical platform component name", async () => {
    const { MeetingRoomIosPad } = await import("./MeetingRoom.ios-pad");

    expect(MeetingRoomIosPad).toBeTypeOf("function");
  });
});
