import { describe, expect, it } from "vitest";

import { DEFAULT_CHALK_THEME_TOKENS, LIGHT_CHALK_THEME_TOKENS } from "./theme-tokens";

describe("Chalk theme tokens", () => {
  it("keeps dark and light themes on the same semantic token contract", () => {
    const tokenNames = ["canvas", "chrome", "surface", "stage", "text", "mutedText", "line", "accent", "accentText", "positive", "danger", "dangerSurface", "focus", "shadow"];

    expect(Object.keys(DEFAULT_CHALK_THEME_TOKENS)).toEqual(tokenNames);
    expect(Object.keys(LIGHT_CHALK_THEME_TOKENS)).toEqual(tokenNames);
    expect(DEFAULT_CHALK_THEME_TOKENS.canvas).not.toBe(LIGHT_CHALK_THEME_TOKENS.canvas);
    expect(DEFAULT_CHALK_THEME_TOKENS.accent).not.toBe(LIGHT_CHALK_THEME_TOKENS.accent);
  });
});
