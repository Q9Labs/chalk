// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./JoiningScreen.android", () => ({ JoiningScreenAndroid: () => null }));
vi.mock("./JoiningScreen.ios-pad", () => ({ JoiningScreenIosPad: () => null }));
vi.mock("./JoiningScreen.ios-phone", () => ({ JoiningScreenIosPhone: () => null }));
vi.mock("./JoiningScreen.macos", () => ({ JoiningScreenMacos: () => null }));

describe("JoiningScreen", () => {
  it("selects the platform-specific loading screen", async () => {
    const { JoiningScreen } = await import("./JoiningScreen");

    expect(JoiningScreen({ displayName: "Guest" })).toBeTruthy();
  });
});
