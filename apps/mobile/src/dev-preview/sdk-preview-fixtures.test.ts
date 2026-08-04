import { describe, expect, it } from "vitest";

import { productionPalette, productionTexture } from "./sdk-preview-fixtures";

describe("native SDK preview fixture", () => {
  it("maps gallery appearance choices to production native tokens", () => {
    expect(productionPalette("midnight")).toBe("oled-signal");
    expect(productionPalette("paper")).toBe("light");
    expect(productionTexture("soft-grid")).toBe("paper");
    expect(productionTexture("soft-dots")).toBe("slate");
    expect(productionTexture("none")).toBe("none");
  });
});
