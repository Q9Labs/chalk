import { describe, expect, it, vi } from "vitest";

vi.mock("./MeetingRoom.shared", () => ({ MeetingRoomShared: () => null }));

describe("MeetingRoom.android", () => {
  it("exposes the canonical platform component name", async () => {
    const { MeetingRoomAndroid } = await import("./MeetingRoom.android");

    expect(MeetingRoomAndroid).toBeTypeOf("function");
  });
});
