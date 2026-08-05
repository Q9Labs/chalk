import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ReactionPicker.tsx", import.meta.url), "utf8");

describe("ReactionPicker", () => {
  it("covers the persistent dock while keeping the reaction card inset", () => {
    expect(source).toContain("StyleSheet.absoluteFillObject");
    expect(source).not.toContain("paddingBottom: 110");
    expect(source).not.toContain("bottom: 94");
  });

  it("keeps close-button press feedback defined", () => {
    expect(source).toContain("pressed && styles.pressed");
    expect(source).toContain("pressed: {");
    expect(source).toContain("opacity: 0.72");
    expect(source).toContain("transform: [{ scale: 0.96 }]");
  });
});
