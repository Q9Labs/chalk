import { describe, expect, it } from "vitest";

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
});
