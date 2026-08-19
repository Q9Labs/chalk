/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocsSidebar } from "./DocsSidebar";

afterEach(cleanup);

describe("DocsSidebar", () => {
  it("groups every documentation link and marks the current page", () => {
    render(<DocsSidebar currentSlug="quickstart" />);

    expect(screen.getByRole("complementary", { name: "Documentation navigation" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Start", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SDKs", level: 2 })).toBeTruthy();

    const quickstart = screen.getByRole("link", { name: "Quickstart" });
    expect(quickstart.getAttribute("href")).toBe("/docs/quickstart");
    expect(quickstart.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Why Chalk" }).getAttribute("aria-current")).toBeNull();
  });

  it("closes the mobile navigation when a page is chosen", () => {
    const onNavigate = vi.fn();
    render(<DocsSidebar currentSlug="" mobile onNavigate={onNavigate} />);

    const sidebar = screen.getByRole("complementary", { name: "Documentation navigation" });
    expect(sidebar.className).toContain("docs-sidebar-mobile");

    const quickstart = screen.getByRole("link", { name: "Quickstart" });
    quickstart.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(quickstart);
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});
