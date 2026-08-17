/* @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteNav } from "./Nav";

describe("SiteNav", () => {
  it("exposes the section anchors and a single account action", () => {
    const markup = renderToStaticMarkup(<SiteNav />);

    expect(markup).toContain('href="#product"');
    expect(markup).toContain('href="#spaces"');
    expect(markup).toContain('href="#speed"');
    expect(markup).toContain('href="#self-host"');
    expect(markup).toContain('href="#platform"');
    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain('href="/sign-up"');
    expect(markup).not.toContain("import.meta.env.DEV");
  });

  it("starts with the small-screen menu collapsed", () => {
    const markup = renderToStaticMarkup(<SiteNav />);

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="nav-menu"');
    expect(markup).toContain("hidden=");
  });

  it("toggles the menu open and closed", () => {
    render(<SiteNav />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    const opened = screen.getByRole("button", { name: "Close menu" });
    expect(opened.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeDefined();

    fireEvent.click(opened);
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
  });
});
