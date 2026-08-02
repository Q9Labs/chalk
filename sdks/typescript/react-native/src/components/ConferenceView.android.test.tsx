import { describe, expect, it, vi } from "vitest";

vi.mock("./ConferenceView.shared", () => ({ ConferenceViewShared: () => null }));

describe("ConferenceView.android", () => {
  it("exposes the canonical platform component name", async () => {
    const { ConferenceViewAndroid } = await import("./ConferenceView.android");

    expect(ConferenceViewAndroid).toBeTypeOf("function");
  });
});
