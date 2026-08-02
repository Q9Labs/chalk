import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./ConferenceView.android", () => ({ ConferenceViewAndroid: () => null }));
vi.mock("./ConferenceView.ios-pad", () => ({ ConferenceViewIosPad: () => null }));
vi.mock("./ConferenceView.ios-phone", () => ({ ConferenceViewIosPhone: () => null }));
vi.mock("./ConferenceView.macos", () => ({ ConferenceViewMacos: () => null }));

describe("ConferenceView", () => {
  it("selects the platform-specific meeting room", async () => {
    const { ConferenceView } = await import("./ConferenceView");

    expect(ConferenceView({ onLeave: vi.fn() })).toBeTruthy();
  });
});
