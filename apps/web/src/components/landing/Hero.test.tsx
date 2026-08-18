/* @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Hero } from "./Hero";

function heroImageSources(): string[] {
  const markup = renderToStaticMarkup(<Hero />);
  return Array.from(markup.matchAll(/<img src="([^"]+)"/g), (match) => match[1]).filter((source) => source !== undefined);
}

describe("Hero", () => {
  it("leads with the Space promise and uses local technology marks", () => {
    const markup = renderToStaticMarkup(<Hero />);

    expect(markup).toContain("Every call ends.");
    expect(markup).toContain("The Space doesn’t.");
    expect(markup).toContain("Open a Space");
    expect(markup).toContain('href="/space"');
    expect(markup).toContain('href="#product"');
    expect(markup).toContain('id="join-space"');
    expect(markup).toContain("TypeScript");
    expect(markup).toContain("React and React Native");
    expect(markup).toContain("/brand/technology/typescript.svg");
    expect(markup).toContain("/brand/technology/cloudflare.svg");
    expect(markup).toContain("/images/landing/chalk-flow-hero-20260818.webp");
    expect(markup).not.toContain("/images/marketing/chalk-speaker-view-20260801.webp");
  });

  it("draws each technology mark once, since React and React Native share a logo", () => {
    const sources = heroImageSources();

    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toHaveLength(new Set(sources).size);
  });

  it("hides every inline icon from assistive technology, since each one repeats its own label", () => {
    const markup = renderToStaticMarkup(<Hero />);
    const openingTags = markup.match(/<svg[^>]*>/g) ?? [];

    expect(openingTags.length).toBeGreaterThan(0);
    for (const tag of openingTags) {
      expect(tag).toContain('aria-hidden="true"');
    }
  });

  it("serves every image from this origin, so no vendor logo is hotlinked", () => {
    const sources = heroImageSources();

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toMatch(/^\//);
    }
  });

  it("greys the half of the headline that carries the turn", () => {
    const markup = renderToStaticMarkup(<Hero />);

    expect(markup).toContain('class="muted"');
    expect(markup).toContain("The Space doesn\u2019t.");
  });

  it("keeps the dashboard out of the hero so one action leads", () => {
    const markup = renderToStaticMarkup(<Hero />);

    expect(markup).not.toContain('href="/home"');
  });

  it("shows an inline error for invalid input and navigates valid input with its hash", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://chalk.test", assign } });

    render(<Hero />);
    const input = screen.getByLabelText("Already been sent a link?");
    const form = input.closest("form");
    expect(form).not.toBeNull();

    fireEvent.change(input, { target: { value: "/not-a-space/token" } });
    fireEvent.submit(form!);
    expect(screen.getByRole("alert").textContent).toContain("valid Space invite link");
    expect(assign).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/space/design-lab#spaceInviteToken=opaque-token" } });
    fireEvent.submit(form!);
    expect(assign).toHaveBeenCalledWith("https://chalk.test/space/design-lab#spaceInviteToken=opaque-token");

    vi.unstubAllGlobals();
  });
});
