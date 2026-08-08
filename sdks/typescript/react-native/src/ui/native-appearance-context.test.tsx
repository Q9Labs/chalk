import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./native-appearance-context.tsx", import.meta.url), "utf8");

describe("NativeAppearanceProvider", () => {
  it("resolves local selections and renders inert textures", () => {
    expect(source).toContain("resolveNativeAppearance(selection)");
    expect(source).toContain("setPalette:");
    expect(source).toContain("setTexture:");
    expect(source).toContain('pointerEvents="none"');
    expect(source).toContain("must be used inside NativeAppearanceProvider");
  });
});
