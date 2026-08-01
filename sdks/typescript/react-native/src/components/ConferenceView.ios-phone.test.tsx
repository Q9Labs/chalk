import { describe, expect, it, vi } from "vitest";

vi.mock("./ConferenceView.shared", () => ({ ConferenceViewShared: () => null }));

describe("ConferenceView.ios-phone", () => {
  it("exposes the canonical platform component name", async () => {
    const { ConferenceViewIosPhone } = await import("./ConferenceView.ios-phone");

    expect(ConferenceViewIosPhone).toBeTypeOf("function");
  });
});
