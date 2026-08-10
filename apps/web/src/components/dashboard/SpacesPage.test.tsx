// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSpaces } from "../../lib/dashboard-api";
import { dashboardTestSpace } from "./__tests__/dialog-fixtures";
import { reconcileSpaceItems, SpacesPage } from "./SpacesPage";

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dashboard-api")>("../../lib/dashboard-api");
  return { ...actual, listSpaces: vi.fn() };
});

const listSpacesMock = vi.mocked(listSpaces);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("Spaces index", () => {
  it("requires an explicit Tenant context before loading resources", () => {
    const markup = renderToStaticMarkup(<SpacesPage />);
    expect(markup).toContain("Select a Tenant");
    expect(markup).not.toContain("Product studio");
  });

  it("renders a live inventory shell for a Tenant", () => {
    const markup = renderToStaticMarkup(<SpacesPage tenantID="10000000-0000-4000-8000-000000000001" />);
    expect(markup).toContain("New Space");
    expect(markup).toContain("Loading Spaces");
    expect(markup).toContain("Archived");
  });

  it("keeps Open Space injectable and hides it for archived rows", async () => {
    const active = dashboardTestSpace();
    const archived = dashboardTestSpace({ id: "space-archived", name: "Archived studio", slug: "archived-studio", archived: true, archived_at: "2026-08-04T10:00:00Z" });
    listSpacesMock.mockResolvedValue({ spaces: [active, archived], pagination: { page_size: 50, next_cursor: null, has_more: false } });

    render(<SpacesPage tenantID="tenant-1" spaceHrefBuilder={(space) => `/custom/${space.slug}`} />);

    expect((await screen.findByRole("link", { name: "Open Space" })).getAttribute("href")).toBe("/custom/product-studio");
    expect(screen.getAllByText("Archived studio").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Open Space" })).toHaveLength(1);
  });

  it("reconciles lifecycle changes with the active filter instead of leaving stale rows", () => {
    const active = dashboardTestSpace();
    const archived = dashboardTestSpace({ archived: true, archived_at: "2026-08-04T10:00:00Z" });

    expect(reconcileSpaceItems([active], archived, "active")).toEqual([]);
    expect(reconcileSpaceItems([archived], active, "archived")).toEqual([]);
    expect(reconcileSpaceItems([], active, "active")).toEqual([active]);
    expect(reconcileSpaceItems([active], { ...active, name: "Renamed" }, "all")[0]?.name).toBe("Renamed");
  });

  it("keeps searching when the current page has no match but a later page exists", async () => {
    const firstPageSpace = dashboardTestSpace();
    const laterPageSpace = dashboardTestSpace({ id: "space-2", name: "Remote lab", slug: "remote-lab" });
    listSpacesMock.mockResolvedValueOnce({ spaces: [firstPageSpace], pagination: { page_size: 50, next_cursor: "cursor-2", has_more: true } }).mockResolvedValueOnce({ spaces: [laterPageSpace], pagination: { page_size: 50, next_cursor: null, has_more: false } });

    render(<SpacesPage tenantID="tenant-1" />);
    await waitFor(() => expect(listSpacesMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("textbox", { name: "Search Spaces" }), { target: { value: "remote" } });
    expect(await screen.findByRole("heading", { name: "No match on this page." })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more Spaces" }));
    await waitFor(() => expect(listSpacesMock).toHaveBeenCalledTimes(2));
    expect(listSpacesMock.mock.calls[1]?.[0]).toMatchObject({ tenantID: "tenant-1", cursor: "cursor-2", pageSize: 50 });
    expect(await screen.findByRole("heading", { name: "Remote lab" })).toBeTruthy();
  });
});
