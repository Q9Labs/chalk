/* @vitest-environment jsdom */

import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocsHeader } from "./DocsHeader";

afterEach(cleanup);

describe("DocsHeader", () => {
  it("links back to Chalk and the account entry points", () => {
    render(<DocsHeader menuButtonRef={createRef<HTMLButtonElement>()} mobileNavOpen={false} onMenuToggle={vi.fn()} onSearchOpen={vi.fn()} />);

    expect(screen.getByRole("link", { name: "Chalk home" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Product" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
    expect(screen.getByRole("link", { name: /Create an account/ }).getAttribute("href")).toBe("/sign-up");
    expect(screen.getByText("Docs")).toBeTruthy();
    expect(document.querySelector('[data-chalk-logo-motion="orbit-burst"]')).toBeTruthy();
    expect(document.querySelector(".docs-logo img")).toBeNull();
  });

  it("opens search and exposes the mobile navigation state", () => {
    const onMenuToggle = vi.fn();
    const onSearchOpen = vi.fn();

    const { rerender } = render(<DocsHeader menuButtonRef={createRef<HTMLButtonElement>()} mobileNavOpen={false} onMenuToggle={onMenuToggle} onSearchOpen={onSearchOpen} />);

    fireEvent.click(screen.getByRole("button", { name: "Search docs" }));
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    expect(onSearchOpen).toHaveBeenCalledOnce();
    expect(onMenuToggle).toHaveBeenCalledOnce();

    rerender(<DocsHeader menuButtonRef={createRef<HTMLButtonElement>()} mobileNavOpen onMenuToggle={onMenuToggle} onSearchOpen={onSearchOpen} />);

    const menuButton = screen.getByRole("button", { name: "Close navigation" });
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(menuButton.getAttribute("aria-controls")).toBe("docs-mobile-navigation");
  });
});
