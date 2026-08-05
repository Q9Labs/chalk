import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("product Home contract", () => {
  it("centers continuation and Quick join instead of operational metrics", () => {
    const source = dashboardSource("ProductHome.tsx");
    expect(source).toContain("Continue where you left off");
    expect(source).toContain("Quick join");
    expect(source).not.toMatch(/revenue|conversion|monthly active|API usage/iu);
  });
});
