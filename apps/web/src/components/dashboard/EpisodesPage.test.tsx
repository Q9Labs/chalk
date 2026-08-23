// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
