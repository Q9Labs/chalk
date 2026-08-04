import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ReactionPicker.tsx", import.meta.url), "utf8");

describe("ReactionPicker", () => {
  it("covers the persistent dock while keeping the reaction card inset", () => {
    expect(source).toContain("StyleSheet.absoluteFillObject");
    expect(source).not.toContain("paddingBottom: 110");
    expect(source).not.toContain("bottom: 94");
  });
});
