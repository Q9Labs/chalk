import { describe, expect, it } from "vitest";

import { chalkThemeStyle, COSMIC_CHALK_THEME } from "./theme";

describe("chalkThemeStyle", () => {
  it("maps the light palette to CSS custom properties by default", () => {
    expect(chalkThemeStyle()).toMatchObject({
      "--chalk-canvas": "#f7f6f2",
      "--chalk-muted-text": "#555b65",
      "--chalk-danger-surface": "#fdf0f0",
      "--chalk-shadow": "0 22px 54px rgba(12, 14, 18, 0.08)",
    });
  });

  it("uses the selected palette and lets accent and token overrides win", () => {
    expect(chalkThemeStyle({ colorScheme: "dark", accent: "#7c3aed", tokens: { surface: "#15151a" } })).toMatchObject({
      "--chalk-canvas": "#0a0a0b",
      "--chalk-text": "#fbffff",
      "--chalk-accent": "#7c3aed",
      "--chalk-focus": "#7c3aed",
      "--chalk-surface": "#15151a",
    });

    expect(chalkThemeStyle({ colorScheme: "dark" }, "light")).toHaveProperty("--chalk-canvas", "#f7f6f2");
  });

  it("ships the Cosmic Chalk convenience preset with its midnight tokens", () => {
    expect(COSMIC_CHALK_THEME).toMatchObject({ palette: "cosmic-chalk", texture: "slate", colorScheme: "dark" });
    expect(chalkThemeStyle(COSMIC_CHALK_THEME)).toMatchObject({
      "--chalk-canvas": "#080f20",
      "--chalk-surface": "#10182b",
      "--chalk-text": "#f4ecd7",
      "--chalk-muted-text": "#aeb8c9",
      "--chalk-accent": "#8fdcff",
      "--chalk-positive": "#93e6c0",
      "--chalk-danger": "#ff9ba8",
    });
  });
});
