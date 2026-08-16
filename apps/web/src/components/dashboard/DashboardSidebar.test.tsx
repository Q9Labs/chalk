/* @vitest-environment jsdom */

import type { ComponentPropsWithoutRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider } from "@q9labsai/chalk-ui";

const mocks = vi.hoisted(() => ({ selectTenant: vi.fn(), signOut: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: ComponentPropsWithoutRef<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("./DashboardAccount", () => ({
  useDashboardAccount: () => ({
    account: { id: "account-1", name: "Ada Lovelace", email: "ada@q9labs.ai" },
    tenants: [
      { tenant: { id: "tenant-1", name: "Analytical Engines" }, access: { role: "owner" } },
      { tenant: { id: "tenant-2", name: "Bletchley" }, access: { role: "member" } },
    ],
    current: { tenant: { id: "tenant-1", name: "Analytical Engines" }, access: { role: "owner" } },
    selectTenant: mocks.selectTenant,
    signOut: mocks.signOut,
  }),
}));

const { DashboardSidebar } = await import("./DashboardSidebar");

function renderSidebar(pathname: string, onCreateSpace = vi.fn()) {
  render(
    <SidebarProvider>
      <DashboardSidebar pathname={pathname} onCreateSpace={onCreateSpace} />
    </SidebarProvider>,
  );
}

describe("DashboardSidebar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.cookie = "chalk_sidebar_state=; path=/; max-age=0";
  });

  it("keeps Developer secondary to the collaboration product", () => {
    renderSidebar("/home");

    const labels = screen.getAllByRole("link").map((link) => link.textContent);
    expect(labels.indexOf("Spaces")).toBeGreaterThan(-1);
    expect(labels.indexOf("Spaces")).toBeLessThan(labels.indexOf("Developer"));
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByText("Tools")).toBeTruthy();
  });

  it("marks the section that owns the current route", () => {
    renderSidebar("/spaces/design-lab");

    const spaces = screen.getByRole("link", { name: "Spaces" });
    expect(spaces.getAttribute("aria-current")).toBe("page");
    expect(spaces.getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("data-active")).toBe("false");
  });

  it("offers the tenant and account switchers plus Space creation", () => {
    const onCreateSpace = vi.fn();
    renderSidebar("/home", onCreateSpace);

    expect(screen.getByRole("button", { name: /Switch Tenant/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Account menu/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /New Space/ }));
    expect(onCreateSpace).toHaveBeenCalledOnce();
  });

  it("collapses to the icon rail from its own trigger", () => {
    renderSidebar("/home");

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));

    const panel = document.querySelector("[data-slot='sidebar']");
    expect(panel?.getAttribute("data-collapsible")).toBe("icon");
  });
});
