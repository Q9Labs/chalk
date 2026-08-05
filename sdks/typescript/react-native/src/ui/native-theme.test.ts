import { describe, expect, it } from "vitest";

import { resolveNativeAppearance } from "./appearance";
import { resolveNativeTheme } from "./native-theme";

describe("resolveNativeTheme", () => {
  it("resolves the public color scheme, accent, and token overrides into semantic colors", () => {
    const theme = resolveNativeTheme({
      colorScheme: "light",
      accent: "#7c3aed",
      tokens: { canvas: "#fefce8", text: "#1c1917" },
    });

    expect(theme.colorScheme).toBe("light");
    expect(theme.colors).toMatchObject({
      background: "#fefce8",
      foreground: "#1c1917",
      primary: "#7c3aed",
      ring: "#7c3aed",
      stageBackground: "#e2e8f0",
    });
  });

  it("projects the selected native palette into rendered theme colors", () => {
    const appearance = resolveNativeAppearance({ palette: "warm-porcelain", texture: "paper" });
    const theme = resolveNativeTheme(undefined, appearance);

    expect(theme.colorScheme).toBe("light");
    expect(theme.colors.background).toBe(appearance.tokens.canvas);
    expect(theme.colors.foreground).toBe(appearance.tokens.text);
    expect(theme.colors.stageBackground).toBe(appearance.tokens.stage);
    expect(theme.colors.primary).toBe(appearance.tokens.controlPrimary);
  });
});
