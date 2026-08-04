import { describe, expect, it } from "vitest";

import { chalkThemeStyle } from "./theme";

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
});
