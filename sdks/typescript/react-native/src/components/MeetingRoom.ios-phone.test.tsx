import { describe, expect, it, vi } from "vitest";

vi.mock("./MeetingRoom.shared", () => ({ MeetingRoomShared: () => null }));

describe("MeetingRoom.ios-phone", () => {
  it("exposes the canonical platform component name", async () => {
    const { MeetingRoomIosPhone } = await import("./MeetingRoom.ios-phone");

    expect(MeetingRoomIosPhone).toBeTypeOf("function");
  });
});
