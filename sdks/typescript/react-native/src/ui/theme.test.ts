import { describe, expect, it } from "vitest";
import { createNativeTheme, Theme } from "./theme";

describe("native theme aliases", () => {
  it("keeps progressive surfaces on the active token set", () => {
    expect(Theme.colors.paper).toBe(Theme.colors.background);
    expect(Theme.colors.ink).toBe(Theme.colors.foreground);
    expect(Theme.colors.lineStrong).toBe(Theme.colors.border);
    expect(Theme.colors.chalkGreen).toBe(Theme.colors.success);
  });

  it("resolves the same aliases for light mode", () => {
    const light = createNativeTheme(
      {
        canvas: "#f8fafc",
        chrome: "#ffffff",
        surface: "#f1f5f9",
        stage: "#e2e8f0",
        text: "#0f172a",
        mutedText: "#475569",
        line: "#cbd5e1",
        accent: "#0f766e",
        accentText: "#ffffff",
        positive: "#15803d",
        danger: "#b91c1c",
        dangerSurface: "#fee2e2",
        focus: "#0f766e",
        shadow: "#0f172a",
      },
      "light",
    );
    expect(light.colors.paper).toBe(light.colors.background);
    expect(light.colors.ink).toBe(light.colors.foreground);
    expect(light.colors.primary).toBe("#0f766e");
  });
});
