import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./EndScreen.android", () => ({ EndScreenAndroid: () => null }));
vi.mock("./EndScreen.ios-pad", () => ({ EndScreenIosPad: () => null }));
vi.mock("./EndScreen.ios-phone", () => ({ EndScreenIosPhone: () => null }));
vi.mock("./EndScreen.macos", () => ({ EndScreenMacos: () => null }));

describe("EndScreen", () => {
  it("selects the platform-specific end screen", async () => {
    const { EndScreen } = await import("./EndScreen");

    expect(EndScreen({ data: { roomId: "room", roomName: "Room", durationSeconds: 1, participantCount: 1, chatCount: 0 }, onGoHome: vi.fn(), onRejoin: vi.fn() })).toBeTruthy();
  });
});
