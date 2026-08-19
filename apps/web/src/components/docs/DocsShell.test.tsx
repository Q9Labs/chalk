/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div data-testid="docs-outlet">Article content</div>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) => select({ location: { pathname: "/docs/quickstart" } }),
}));

import { DocsShell } from "./DocsShell";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("DocsShell", () => {
  it("composes the article outlet, navigation, and footer", () => {
    render(<DocsShell />);

    expect(screen.getByTestId("docs-outlet")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Quickstart" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens search and the mobile navigation from keyboard and button controls", () => {
    render(<DocsShell />);

    fireEvent.keyDown(window, { key: "/" });
    expect(screen.getByRole("dialog", { name: "Search documentation" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search documentation" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Documentation navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Documentation navigation" })).toBeNull();
  });
});
