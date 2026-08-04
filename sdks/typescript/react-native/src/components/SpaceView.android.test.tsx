import { describe, expect, it, vi } from "vitest";

vi.mock("./SpaceView.shared", () => ({ SpaceViewShared: () => null }));

describe("SpaceView.android", () => {
  it("exposes the canonical platform component name", async () => {
    const { SpaceViewAndroid } = await import("./SpaceView.android");

    expect(SpaceViewAndroid).toBeTypeOf("function");
  });
});
