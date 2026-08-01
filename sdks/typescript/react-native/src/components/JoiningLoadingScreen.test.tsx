import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./JoiningLoadingScreen.android", () => ({ JoiningLoadingScreenAndroid: () => null }));
vi.mock("./JoiningLoadingScreen.ios-pad", () => ({ JoiningLoadingScreenIosPad: () => null }));
vi.mock("./JoiningLoadingScreen.ios-phone", () => ({ JoiningLoadingScreenIosPhone: () => null }));
vi.mock("./JoiningLoadingScreen.macos", () => ({ JoiningLoadingScreenMacos: () => null }));

describe("JoiningLoadingScreen", () => {
  it("selects the platform-specific loading screen", async () => {
    const { JoiningLoadingScreen } = await import("./JoiningLoadingScreen");

    expect(JoiningLoadingScreen({ displayName: "Guest" })).toBeTruthy();
  });
});
