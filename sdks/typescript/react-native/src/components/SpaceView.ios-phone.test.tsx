import { describe, expect, it, vi } from "vitest";

vi.mock("./SpaceView.shared", () => ({ SpaceViewShared: () => null }));

describe("SpaceView.ios-phone", () => {
  it("exposes the canonical platform component name", async () => {
    const { SpaceViewIosPhone } = await import("./SpaceView.ios-phone");

    expect(SpaceViewIosPhone).toBeTypeOf("function");
  });
});
