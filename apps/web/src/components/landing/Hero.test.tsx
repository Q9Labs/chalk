import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Hero, SiteNav } from "./Hero";

describe("SiteNav", () => {
  it("links to the core landing page sections", () => {
    const markup = renderToStaticMarkup(<SiteNav />);

    expect(markup).toContain('href="#sdk"');
    expect(markup).toContain('href="#performance"');
    expect(markup).toContain('href="#self-host"');
  });
});

describe("Hero", () => {
  it("renders the approved straight-on product direction with accessible copy", () => {
    const markup = renderToStaticMarkup(<Hero />);

    expect(markup).toContain("/images/marketing/chalk-speaker-view-20260801.webp");
    expect(markup).toContain("Chalk Space interface");
    expect(markup).toContain("Real-time Spaces.");
    expect(markup).toContain("Your way.");
    expect(markup).not.toContain("eyebrow");
    expect(markup).toContain("View SDK preview");
    expect(markup).toContain('aria-label="TypeScript"');
    expect(markup).toContain('aria-label="React Native"');
    expect(markup).not.toContain("Supported product surfaces");
    expect(markup).not.toContain("The hosted product remains under active development");
    expect(markup).not.toContain('href="/new"');
  });
});
