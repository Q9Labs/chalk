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
  it("renders the product screenshot with accessible alt text", () => {
    const markup = renderToStaticMarkup(<Hero />);

    expect(markup).toContain("/images/marketing/hero-2.png");
    expect(markup).toContain("Chalk meeting interface concept");
    expect(markup).toContain("View SDK preview");
    expect(markup).not.toContain('href="/new"');
  });
});
