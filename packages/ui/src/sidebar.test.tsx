// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar, SidebarContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "./sidebar";

function renderSidebar() {
  return render(
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive tooltip="Overview">
                <span>Overview</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>,
  );
}

function panel(): HTMLElement {
  const element = document.querySelector("[data-slot='sidebar']");
  if (!(element instanceof HTMLElement)) throw new Error("the sidebar panel is missing");
  return element;
}

describe("Sidebar", () => {
  afterEach(() => {
    cleanup();
    document.cookie = "chalk_sidebar_state=; path=/; max-age=0";
  });

  it("starts expanded, marks the active item, and collapses to the icon rail on the trigger", () => {
    renderSidebar();

    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(panel().getAttribute("data-collapsible")).toBe("");
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("data-active")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));

    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(panel().getAttribute("data-collapsible")).toBe("icon");
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeTruthy();
  });

  it("toggles on the meta+B shortcut and remembers the state in a cookie", () => {
    renderSidebar();

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(document.cookie).toContain("chalk_sidebar_state=false");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(document.cookie).toContain("chalk_sidebar_state=true");
  });

  it("leaves an unmodified b keypress to the page", () => {
    renderSidebar();

    fireEvent.keyDown(window, { key: "b" });

    expect(panel().getAttribute("data-state")).toBe("expanded");
  });

  it("renders the menu button as the element handed to render", () => {
    const onClick = vi.fn();
    render(
      <SidebarProvider>
        <SidebarMenuButton render={<a href="/spaces" />} onClick={onClick}>
          <span>Spaces</span>
        </SidebarMenuButton>
      </SidebarProvider>,
    );

    const link = screen.getByRole("link", { name: "Spaces" });
    expect(link.getAttribute("data-slot")).toBe("sidebar-menu-button");
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
