import { describe, expect, it, vi } from "vitest";

vi.mock("./ConferenceView.shared", () => ({ ConferenceViewShared: () => null }));

describe("ConferenceView.macos", () => {
  it("exposes the canonical platform component name", async () => {
    const { ConferenceViewMacos } = await import("./ConferenceView.macos");

    expect(ConferenceViewMacos).toBeTypeOf("function");
  });
});
