import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./EntranceView.android", () => ({ EntranceViewAndroid: () => null }));
vi.mock("./EntranceView.ios-pad", () => ({ EntranceViewIosPad: () => null }));
vi.mock("./EntranceView.ios-phone", () => ({ EntranceViewIosPhone: () => null }));
vi.mock("./EntranceView.macos", () => ({ EntranceViewMacos: () => null }));

describe("EntranceView", () => {
  it("selects the platform-specific entrance", async () => {
    const { EntranceView } = await import("./EntranceView");

    expect(EntranceView({ spaceName: "Space", onJoin: vi.fn() })).toBeTruthy();
  });
});
