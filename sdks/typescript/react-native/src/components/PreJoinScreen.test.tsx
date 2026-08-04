import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./PreJoinScreen.android", () => ({ PreJoinScreenAndroid: () => null }));
vi.mock("./PreJoinScreen.ios-pad", () => ({ PreJoinScreenIosPad: () => null }));
vi.mock("./PreJoinScreen.ios-phone", () => ({ PreJoinScreenIosPhone: () => null }));
vi.mock("./PreJoinScreen.macos", () => ({ PreJoinScreenMacos: () => null }));

describe("PreJoinScreen", () => {
  it("selects the platform-specific pre-join lobby", async () => {
    const { PreJoinScreen } = await import("./PreJoinScreen");

    expect(PreJoinScreen({ roomName: "Room", onJoin: vi.fn(), previewMode: "disabled" })).toBeTruthy();
  });
});
