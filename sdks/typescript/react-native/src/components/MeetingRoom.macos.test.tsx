import { describe, expect, it, vi } from "vitest";

vi.mock("./MeetingRoom.shared", () => ({ MeetingRoomShared: () => null }));

describe("MeetingRoom.macos", () => {
  it("exposes the canonical platform component name", async () => {
    const { MeetingRoomMacos } = await import("./MeetingRoom.macos");

    expect(MeetingRoomMacos).toBeTypeOf("function");
  });
});
