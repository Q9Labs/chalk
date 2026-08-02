import { describe, expect, it } from "vitest";

describe("ChalkProvider", () => {
  it("exports the canonical provider and session hook", async () => {
    const provider = await import("./chalk-provider");

    expect(provider.ChalkProvider).toBeTypeOf("function");
    expect(provider.useChalkSession).toBeTypeOf("function");
  });
});
