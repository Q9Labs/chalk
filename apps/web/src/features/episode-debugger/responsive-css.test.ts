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
});
