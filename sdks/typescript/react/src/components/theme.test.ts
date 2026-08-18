import { describe, expect, it } from "vitest";

import { getThemeMode, THEME_PALETTES, THEME_SKINS, THEME_TEXTURES } from "./theme";

describe("appearance metadata", () => {
  it("defines unique palette values and classifies every color family", () => {
    const values = THEME_PALETTES.map((palette) => palette.value);

    expect(new Set(values).size).toBe(values.length);
    expect(getThemeMode("warm-porcelain")).toBe("light");
    expect(getThemeMode("oled-signal")).toBe("dark");
    expect(getThemeMode("cosmic-chalk")).toBe("dark");
    expect(THEME_PALETTES.find((palette) => palette.value === "cosmic-chalk")).toMatchObject({ family: "Cosmic", swatch: ["#080f20", "#10182b", "#8fdcff"] });
    expect(THEME_PALETTES.filter((palette) => palette.mode === "light")).toHaveLength(8);
    expect(THEME_PALETTES.filter((palette) => palette.mode === "dark")).toHaveLength(8);
    expect(THEME_TEXTURES.map((texture) => texture.value)).toEqual(["none", "paper", "slate"]);
    expect(THEME_SKINS.map((skin) => skin.value)).toEqual(["classic", "chalk"]);
    expect(THEME_SKINS).toEqual([
      { value: "classic", label: "Classic", description: "Clean, polished controls with rounded token-based surfaces." },
      { value: "chalk", label: "Chalk", description: "Hand-drawn outlines and layered strokes for a tactile finish." },
    ]);
  });
});
