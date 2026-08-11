import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./dashboard-dark-foundation.css", import.meta.url), "utf8");

describe("dark dashboard foundation", () => {
  it("defines the shared dark Chalk palette", () => {
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain("--paper: #0a0f15");
    expect(css).toContain("--surface: #131a22");
    expect(css).toContain("--chalk-blue: #168cff");
  });

  it("removes eyebrow, navigation-bar, and dialog-accent decoration", () => {
    expect(css).toContain(".dashboard-shell .eyebrow");
    expect(css).toContain(".dashboard-shell .dashboard-nav a.is-active::after");
    expect(css).toContain(".space-dialog-accent");
    expect(css.match(/display: none;/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the common fallback, auth, onboarding, settings, and dialog surfaces in the same system", () => {
    expect(css).toContain(".dashboard-gate-state");
    expect(css).toContain(".account-entry-story");
    expect(css).toContain(".tenant-onboarding");
    expect(css).toContain(".settings-panel");
    expect(css).toContain(".space-dialog");
    expect(css).toContain(".episode-dialog");
  });
});
