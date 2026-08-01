import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./MeetingRoom.android", () => ({ MeetingRoomAndroid: () => null }));
vi.mock("./MeetingRoom.ios-pad", () => ({ MeetingRoomIosPad: () => null }));
vi.mock("./MeetingRoom.ios-phone", () => ({ MeetingRoomIosPhone: () => null }));
vi.mock("./MeetingRoom.macos", () => ({ MeetingRoomMacos: () => null }));

describe("MeetingRoom", () => {
  it("selects the platform-specific meeting room", async () => {
    const { MeetingRoom } = await import("./MeetingRoom");

    expect(MeetingRoom({ onLeave: vi.fn() })).toBeTruthy();
  });
});
