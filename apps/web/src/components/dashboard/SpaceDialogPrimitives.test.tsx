import { describe, expect, it } from "vitest";
import { slugifySpaceName } from "./SpaceDialogPrimitives";

describe("Space dialog primitives", () => {
  it("creates bounded URL-safe Space slugs", () => {
    expect(slugifySpaceName("  Product & Research  ")).toBe("product-research");
    expect(slugifySpaceName(`a${"b".repeat(100)}`)).toHaveLength(80);
  });
});
