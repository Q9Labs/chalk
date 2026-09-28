import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expandFontFamilies, registerSubsetFamily } from "./fonts.js";

describe("font families", () => {
  it("expands registered family names without changing unrelated families", async () => {
    const directory = fileURLToPath(new URL("../browser/fonts/", import.meta.url));
    const registered = await registerSubsetFamily("Figtree", directory);
    expect(registered).toContain("Figtree__0, Figtree__1, Apple Color Emoji, Noto Color Emoji, sans-serif");
    expect(expandFontFamilies('600 14px "Figtree", Arial')).toBe("600 14px Figtree__0, Figtree__1, Apple Color Emoji, Noto Color Emoji, Arial");
    expect(expandFontFamilies("12px Arial")).toBe("12px Arial");
  });
});
