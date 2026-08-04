import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./SpaceView.android", () => ({ SpaceViewAndroid: () => null }));
vi.mock("./SpaceView.ios-pad", () => ({ SpaceViewIosPad: () => null }));
vi.mock("./SpaceView.ios-phone", () => ({ SpaceViewIosPhone: () => null }));
vi.mock("./SpaceView.macos", () => ({ SpaceViewMacos: () => null }));

describe("SpaceView", () => {
  it("selects the platform-specific Space", async () => {
    const { SpaceView } = await import("./SpaceView");

    expect(SpaceView({ onLeave: vi.fn() })).toBeTruthy();
  });
});
