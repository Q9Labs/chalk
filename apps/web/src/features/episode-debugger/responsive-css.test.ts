import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./episode-debugger.css", import.meta.url), "utf8");

describe("Episode Debugger responsive contract", () => {
  it("keeps Copy all and labeled navigation available at the 1024 layout", () => {
    expect(css).not.toContain('.episode-top-actions [data-slot="button"]:first-child');
    expect(css).not.toContain('.episode-nav [data-slot="button"] > span:not(.episode-nav-icon)');
  });

  it("keeps retention visible at 1280 and consumes the shared danger token", () => {
    const width1280 = css.slice(css.indexOf("@media (max-width: 1280px)"), css.indexOf("@media (max-width: 1100px)"));
    expect(width1280).not.toContain(".episode-retention");
    expect(css).not.toContain("var(--danger)");
    expect(css).toContain("var(--danger-foreground)");
  });

  it("keeps the two-level shell and controls usable on narrow screens", () => {
    expect(css).toContain(".episode-contextbar");
    expect(css).toContain(".episode-titlebar");
    expect(css).toContain(".episode-summary-grid");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("min-block-size: 42px");
    expect(css).toContain(".episode-debugger > *");
    expect(css).toContain("max-inline-size: 100%");
  });

  it("provides a visible focus treatment for every interactive debugger control", () => {
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("outline-offset: 3px");
    expect(css).toContain("box-shadow: 0 0 0 4px");
  });
});
