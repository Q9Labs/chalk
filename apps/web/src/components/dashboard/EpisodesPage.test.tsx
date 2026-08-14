// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardEpisode } from "../../lib/dashboard-api";
import { EpisodesPage, type EpisodeClient } from "./EpisodesPage";

const tenantID = "tenant-1";
const space = { id: "space-1", name: "Product studio", slug: "product-studio", archived: false };

function episode(overrides: Partial<DashboardEpisode> = {}): DashboardEpisode {
  return {
    id: "episode-1",
    tenant_id: tenantID,
    space_id: space.id,
    status: "ended",
    metadata: { source: "test" },
    config_snapshot: { admission_policy: "open", linger_window_seconds: 45 },
    end_reason: "explicit",
    started_at: "2026-08-04T09:00:00Z",
    ended_at: "2026-08-04T09:42:00Z",
    deadline_at: "2026-08-04T11:00:00Z",
    deadline_generation: 0,
    updated_at: "2026-08-04T09:42:00Z",
    created_at: "2026-08-04T09:00:00Z",
    ...overrides,
  };
}

function client(overrides: Partial<EpisodeClient> = {}): EpisodeClient {
  return {
    listSpaces: vi.fn().mockResolvedValue({ spaces: [space], pagination: { page_size: 100, next_cursor: null, has_more: false } }),
    listEpisodes: vi.fn().mockResolvedValue({ episodes: [episode()], pagination: { page_size: 25, next_cursor: null, has_more: false } }),
    getEpisode: vi.fn().mockResolvedValue(episode()),
    createEpisode: vi.fn().mockResolvedValue(episode({ id: "episode-new", status: "active", ended_at: null, end_reason: null })),
    endEpisode: vi.fn().mockResolvedValue({ status: "requested" }),
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/episodes");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Episodes page", () => {
  it("renders the Tenant-wide history contract and optional start language", () => {
    const markup = renderToStaticMarkup(<EpisodesPage tenantID={tenantID} api={client()} />);
    expect(markup).toContain("Tenant-wide history");
    expect(markup).toContain("Start and join");
    expect(markup).toContain("Starting an Episode is optional");
  });

  it("loads Space-filtered history and keeps ended Episodes immutable", async () => {
    const getEpisode = vi.fn().mockResolvedValue(episode());
    const api = client({ getEpisode });
    render(<EpisodesPage tenantID={tenantID} api={api} />);

    const episodeRow = await screen.findByRole("button", { name: /Product studio/ });
    fireEvent.click(episodeRow);
    expect(await screen.findByText("Immutable history")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End Episode" })).toBeNull();
    expect(getEpisode).toHaveBeenCalledWith({ tenantID, spaceID: space.id, episodeID: "episode-1" });
  });

  it("shows the Space slug and an injectable Open Space link while keeping history read-only", async () => {
    render(<EpisodesPage tenantID={tenantID} api={client()} spaceHrefBuilder={(item) => `/custom-space/${item.slug}`} />);

    await screen.findByRole("button", { name: /Product studio/ });
    expect(screen.getByText("product-studio")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Join Space" }).getAttribute("href")).toBe("/custom-space/product-studio");
  });

  it("opens diagnostics from the selected Episode without making the operator find a reference", async () => {
    vi.stubGlobal("__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__", true);
    const diagnosticsApi = { resolveAlternate: vi.fn().mockResolvedValue("chalkdiag:v1:localhost:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") };
    render(<EpisodesPage tenantID={tenantID} api={client()} diagnosticsApi={diagnosticsApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /Product studio/ }));

    const link = await screen.findByRole("link", { name: "Inspect diagnostics" });
    expect(link.getAttribute("href")).toContain(encodeURIComponent("chalk.episode:episode-1"));
  });

  it("starts an Episode from the selected Space and opens the Space", async () => {
    const createEpisode = vi.fn().mockResolvedValue(episode({ id: "episode-new", status: "active", ended_at: null, end_reason: null }));
    const getEpisode = vi.fn().mockImplementation(({ episodeID }: { episodeID: string }) => Promise.resolve(episode({ id: episodeID, status: "active", ended_at: null, end_reason: null })));
    const navigateToSpace = vi.fn();
    const api = client({ createEpisode, getEpisode });
    render(<EpisodesPage tenantID={tenantID} api={api} navigateToSpace={navigateToSpace} />);

    await screen.findByRole("button", { name: /Product studio/ });
    fireEvent.click(screen.getByRole("button", { name: "Start and join" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start and join" }));

    await waitFor(() => expect(createEpisode).toHaveBeenCalledWith({ tenantID, spaceID: space.id }));
    expect(navigateToSpace).toHaveBeenCalledWith("/space/product-studio?entry=dashboard");
  });

  it("does not offer archived Spaces as Episode start choices", async () => {
    const archivedSpace = { ...space, id: "space-archived", name: "Archived studio", archived: true };
    const api = client({
      listSpaces: vi.fn().mockResolvedValue({ spaces: [space, archivedSpace], pagination: { page_size: 100, next_cursor: null, has_more: false } }),
    });
    render(<EpisodesPage tenantID={tenantID} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Start and join" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("option", { name: "Product studio" })).toBeTruthy();
    expect(within(dialog).queryByRole("option", { name: "Archived studio" })).toBeNull();
  });

  it("keeps history pagination reachable when the current status filter has no matches", async () => {
    const live = episode({ status: "active", ended_at: null, end_reason: null });
    const api = client({
      listEpisodes: vi.fn().mockResolvedValue({ episodes: [live], pagination: { page_size: 25, next_cursor: "next-page", has_more: true } }),
    });
    render(<EpisodesPage tenantID={tenantID} api={api} />);

    await screen.findByRole("button", { name: /Product studio/ });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "ended" } });

    expect(await screen.findByText("Try another filter.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Episode history pages" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });

  it("resets Episode filters, cursors, and details when the Tenant changes", async () => {
    const tenantA = "tenant-a";
    const tenantB = "tenant-b";
    const spaceA = { ...space, id: "space-a", name: "Product studio" };
    const spaceB = { ...space, id: "space-b", name: "Design lab" };
    const episodeA = episode({ id: "episode-a", tenant_id: tenantA, space_id: spaceA.id });
    const episodeB = episode({ id: "episode-b", tenant_id: tenantB, space_id: spaceB.id });
    const listSpaces = vi.fn().mockImplementation(({ tenantID }: { tenantID: string }) => Promise.resolve({ spaces: [tenantID === tenantA ? spaceA : spaceB], pagination: { page_size: 100, next_cursor: null, has_more: false } }));
    const listEpisodes = vi
      .fn()
      .mockImplementation(({ tenantID, cursor }: { tenantID: string; cursor?: string }) =>
        Promise.resolve({ episodes: [tenantID === tenantA ? episodeA : episodeB], pagination: { page_size: 25, next_cursor: tenantID === tenantA && !cursor ? "cursor-a" : null, has_more: tenantID === tenantA && !cursor } }),
      );
    const getEpisode = vi.fn().mockImplementation(({ episodeID }: { episodeID: string }) => Promise.resolve(episodeID === episodeA.id ? episodeA : episodeB));
    const api = client({ listSpaces, listEpisodes, getEpisode });
    window.history.replaceState({}, "", `/episodes?space=${spaceA.id}&episode=${episodeA.id}`);
    const { rerender } = render(<EpisodesPage tenantID={tenantA} api={api} />);

    expect(await screen.findByRole("complementary", { name: "Episode details" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(listEpisodes).toHaveBeenCalledWith(expect.objectContaining({ tenantID: tenantA, cursor: "cursor-a" })));

    rerender(<EpisodesPage tenantID={tenantB} api={api} />);

    expect(await screen.findByRole("button", { name: /Design lab/ })).toBeTruthy();
    expect((screen.getAllByLabelText("Space")[0] as unknown as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Status") as unknown as HTMLSelectElement).value).toBe("all");
    expect(screen.queryByRole("complementary", { name: "Episode details" })).toBeNull();
    await waitFor(() => expect(listEpisodes).toHaveBeenLastCalledWith(expect.objectContaining({ tenantID: tenantB, cursor: undefined, spaceID: undefined })));
  });

  it("requires confirmation before ending a live Episode", async () => {
    const live = episode({ status: "active", ended_at: null, end_reason: null });
    const ended = episode({ status: "ended" });
    const endEpisode = vi.fn().mockResolvedValue({ status: "requested" });
    const getEpisode = vi.fn().mockResolvedValueOnce(live).mockResolvedValue(ended);
    const api = client({ listEpisodes: vi.fn().mockResolvedValue({ episodes: [live], pagination: { page_size: 25, next_cursor: null, has_more: false } }), getEpisode, endEpisode });
    render(<EpisodesPage tenantID={tenantID} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /Product studio/ }));
    fireEvent.click(await screen.findByRole("button", { name: "End Episode" }));
    expect(await screen.findByRole("heading", { name: "End this Episode?" })).toBeTruthy();
    const confirmationButtons = screen.getAllByRole("button", { name: "End Episode" });
    fireEvent.click(confirmationButtons.at(-1)!);

    await waitFor(() => expect(endEpisode).toHaveBeenCalledWith({ tenantID, spaceID: space.id, episodeID: live.id }));
    expect(await screen.findByText("Immutable history")).toBeTruthy();
  });

  it("renders a retryable permission-safe error without resource details", async () => {
    const api = client({
      listEpisodes: vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 })),
    });
    render(<EpisodesPage tenantID={tenantID} api={api} />);

    expect(await screen.findByText("Episodes are temporarily unavailable.")).toBeTruthy();
    expect(screen.getByText("You do not have access to this Episode history.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("episode-1")).toBeNull();
  });
});
