import { describe, expect, it, vi } from "vitest";

vi.mock("./SpaceView.shared", () => ({ SpaceViewShared: () => null }));

describe("SpaceView.macos", () => {
  it("exposes the canonical platform component name", async () => {
    const { SpaceViewMacos } = await import("./SpaceView.macos");

    expect(SpaceViewMacos).toBeTypeOf("function");
  });
});
