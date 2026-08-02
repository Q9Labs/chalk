import { describe, expect, it, vi } from "vitest";

vi.mock("./ConferenceView.shared", () => ({ ConferenceViewShared: () => null }));

describe("ConferenceView.ios-pad", () => {
  it("exposes the canonical platform component name", async () => {
    const { ConferenceViewIosPad } = await import("./ConferenceView.ios-pad");

    expect(ConferenceViewIosPad).toBeTypeOf("function");
  });
});
