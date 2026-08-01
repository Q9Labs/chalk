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
    expect(markup).toContain("Chalk speaker-view meeting interface");
    expect(markup).toContain("Video calls.");
    expect(markup).toContain("Your call.");
    expect(markup).not.toContain("eyebrow");
    expect(markup).toContain("View SDK preview");
    expect(markup).not.toContain('href="/new"');
  });
});
