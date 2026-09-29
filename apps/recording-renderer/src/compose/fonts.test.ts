import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expandFontFamilies, registerSubsetFamily, registerTextFallback } from "./fonts.js";

describe("font families", () => {
  it("expands registered family names without changing unrelated families", async () => {
    const directory = fileURLToPath(new URL("../browser/fonts/", import.meta.url));
    const registered = await registerSubsetFamily("Figtree", directory);
    expect(registered).toContain("Figtree__0, Figtree__1, Apple Color Emoji, Noto Color Emoji, sans-serif");
    expect(expandFontFamilies('600 14px "Figtree", Arial')).toBe("600 14px Figtree__0, Figtree__1, Apple Color Emoji, Noto Color Emoji, Arial");
    expect(expandFontFamilies("12px Arial")).toBe("12px Arial");
  });

  it("puts the text fallback between a family's subsets and emoji", async () => {
    const directory = fileURLToPath(new URL("../browser/fonts/", import.meta.url));
    await registerTextFallback(directory);
    const registered = await registerSubsetFamily("Figtree", directory);
    expect(registered).toContain("Figtree__1, TextFallback__0, TextFallback__1, Apple Color Emoji");
  });
});
