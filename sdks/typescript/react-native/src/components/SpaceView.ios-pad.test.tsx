import { describe, expect, it, vi } from "vitest";

vi.mock("./SpaceView.shared", () => ({ SpaceViewShared: () => null }));

describe("SpaceView.ios-pad", () => {
  it("exposes the canonical platform component name", async () => {
    const { SpaceViewIosPad } = await import("./SpaceView.ios-pad");

    expect(SpaceViewIosPad).toBeTypeOf("function");
  });
});
