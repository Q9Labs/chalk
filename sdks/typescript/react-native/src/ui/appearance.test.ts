import { describe, expect, it } from "vitest";

import { THEME_PALETTES as REACT_THEME_PALETTES, THEME_TEXTURES as REACT_THEME_TEXTURES } from "../../../react/src/components/theme";

import { getThemeMode, isDarkThemePalette, resolveNativeAppearance, THEME_PALETTES, THEME_TEXTURES } from "./appearance";

describe("React Native appearance catalog", () => {
  it("keeps palette and texture metadata in parity with React", () => {
    expect(THEME_PALETTES.map(({ value, label, family, mode, swatch }) => ({ value, label, family, mode, swatch }))).toEqual(REACT_THEME_PALETTES);
    expect(THEME_TEXTURES.map(({ value, label, description }) => ({ value, label, description }))).toEqual(REACT_THEME_TEXTURES);
    expect(THEME_PALETTES).toHaveLength(15);
    expect(THEME_PALETTES.filter((palette) => palette.mode === "light")).toHaveLength(8);
    expect(THEME_PALETTES.filter((palette) => palette.mode === "dark")).toHaveLength(7);
    expect(THEME_TEXTURES.map((texture) => texture.value)).toEqual(["none", "paper", "slate"]);
  });

  it("carries every CSS appearance token as a native value", () => {
    for (const palette of THEME_PALETTES) {
      expect(palette.tokens.canvas).toMatch(/^#[0-9a-f]{6}$/);
      expect(palette.tokens.tileColorStrength).toBeGreaterThan(0);
      expect(palette.tokens.tileColorStrength).toBeLessThanOrEqual(1);
      expect(palette.tokens.shadows.xs.offset.width).toBe(0);
      expect(palette.tokens.shadows.sm.radius).toBeGreaterThanOrEqual(0);
      expect(palette.tokens.shadows.control.elevation).toBeGreaterThanOrEqual(0);
    }

    expect(THEME_PALETTES[0].tokens).toMatchObject({ canvas: "#f7f6f2", panel: "#ffffff", controlPrimary: "#202329", input: "#fbfaf7" });
    expect(THEME_PALETTES.find((palette) => palette.value === "warm-porcelain")?.tokens).toMatchObject({ canvas: "#f2ebe2", stage: "#eee4dc", controlPrimary: "#51443c" });
    expect(THEME_PALETTES.find((palette) => palette.value === "oled-signal")?.tokens).toMatchObject({ canvas: "#000000", stage: "#000000", shadows: { xs: { opacity: 0 }, sm: { opacity: 0 } } });
  });

  it("resolves mode and native texture primitives independently", () => {
    expect(isDarkThemePalette("warm-charcoal")).toBe(true);
    expect(isDarkThemePalette("warm-porcelain")).toBe(false);
    expect(getThemeMode("prism-nocturne")).toBe("dark");
    expect(getThemeMode("prism-daylight")).toBe("light");

    expect(resolveNativeAppearance()).toMatchObject({ palette: "light", mode: "light", texture: "none", textureDescriptor: { kind: "none", opacity: 0, tileSize: null } });

    const lightSlate = resolveNativeAppearance({ palette: "warm-porcelain", texture: "slate" });
    expect(lightSlate.mode).toBe("light");
    expect(lightSlate.tokens.canvas).toBe("#f2ebe2");
    expect(lightSlate.textureDescriptor).toMatchObject({ kind: "slate", blendMode: "multiply", opacity: 0.16, lines: { color: "#0c0e12", opacity: 0.022 } });

    const darkSlate = resolveNativeAppearance({ palette: "oled-signal", texture: "slate" });
    expect(darkSlate.mode).toBe("dark");
    expect(darkSlate.tokens.canvas).toBe("#000000");
    expect(darkSlate.textureDescriptor).toMatchObject({ kind: "slate", blendMode: "soft-light", opacity: 0.2, lines: { color: "#ffffff", opacity: 0.018 } });
  });
});
