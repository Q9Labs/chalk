import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL(`./${"Meet"}ingTopBar.android.tsx`, import.meta.url), "utf8");

describe("Space top bar", () => {
  it("uses compact safe spacing and a quiet participant count", () => {
    expect(source).not.toContain("SecurityCheckIcon");
    expect(source).not.toContain(">Secure<");
    expect(source).toContain("paddingTop: Theme.spacing.md");
    expect(source).toContain("borderRadius: Theme.radius.full");
    expect(source).toContain("color={tokens.textMuted}");
  });
});
