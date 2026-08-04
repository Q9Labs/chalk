import { describe, expect, it } from "vitest";
import { Theme } from "./theme";

describe("Chalk Light theme", () => {
  it("exposes the warm-light foundation tokens", () => {
    expect(Theme.colors.paper).toBe("#F7F6F2");
    expect(Theme.colors.paper2).toBe("#F1F0EB");
    expect(Theme.colors.surface).toBe("#FFFFFF");
    expect(Theme.colors.surfaceMuted).toBe("#FBFAF7");
    expect(Theme.colors.ink).toBe("#0C0E12");
    expect(Theme.colors.ink2).toBe("#555B65");
    expect(Theme.colors.ink3).toBe("#858A92");
    expect(Theme.colors.line).toBe("#DEDDD7");
    expect(Theme.colors.lineStrong).toBe("#C9C8C2");
  });

  it("keeps existing semantic names readable while making primary decisive", () => {
    expect(Theme.colors.background).toBe(Theme.colors.paper);
    expect(Theme.colors.foreground).toBe(Theme.colors.ink);
    expect(Theme.colors.primary).toBe(Theme.colors.ink);
    expect(Theme.colors.primary).not.toBe(Theme.colors.brandTeal);
    expect(Theme.colors.card).toBe(Theme.colors.surface);
    expect(Theme.colors.border).toBe(Theme.colors.line);
  });
});
