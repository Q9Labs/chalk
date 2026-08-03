import { describe, expect, it } from "vitest";

import { resolvePortalThemeFromDocument } from "./theme";

describe("resolvePortalThemeFromDocument", () => {
  it("returns the light default during server rendering", () => {
    expect(resolvePortalThemeFromDocument()).toBe("light");
  });

  it("allows callers to choose a server-rendering default", () => {
    expect(resolvePortalThemeFromDocument({ defaultTheme: "dark" })).toBe("dark");
  });
});
