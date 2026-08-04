import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./AppearanceSettings.tsx", import.meta.url), "utf8");

describe("AppearanceSettings", () => {
  it("exposes every palette family and texture as an accessible selection", () => {
    expect(source).toContain('(["light", "dark"] as const)');
    expect(source).toContain("THEME_PALETTES.filter");
    expect(source).toContain("THEME_TEXTURES.map");
    expect(source).toContain("accessibilityState={{ selected }}");
    expect(source).toContain("setPalette");
    expect(source).toContain("setTexture");
  });
});
