/* @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardEpisodePage, DashboardPublicAdmissionRequest, Space } from "../../lib/dashboard-api";
import { SpaceDetailPage, type SpaceDetailClient } from "./SpaceDetailPage";

const space: Space = {
  admission_policy: { mode: "knock" },
  archived: false,
  created_at: "2026-08-25T00:00:00.000Z",
  created_by_user_id: "user-1",
  default_episode_duration_seconds: 3_600,
  id: "space-1",
  linger_window_seconds: 0,
  maximum_episode_duration_seconds: 86_400,
  media_plane: "cf_rtk",
  metadata: {},
  name: "Product ask",
  recurring_policy: null,
  roles: [],
  slug: "product-ask",
  tenant_id: "tenant-1",
  updated_at: "2026-08-25T00:00:00.000Z",
};

const episodes: DashboardEpisodePage = {
  episodes: [],
  pagination: { has_more: false, next_cursor: null, page_size: 10 },
};

const request: DashboardPublicAdmissionRequest = {
  display_name: "Ada",
  expires_at: "2026-08-25T01:00:00.000Z",
  request_handle: "request-1",
  requested_at: "2026-08-25T00:01:00.000Z",
  state: "pending",
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SpaceDetailPage admission requests", () => {
  it("refreshes an initially empty request list", async () => {
    const listSpacePublicAdmissionRequests = vi
      .fn<NonNullable<SpaceDetailClient["listSpacePublicAdmissionRequests"]>>()
      .mockResolvedValueOnce({ requests: [] })
      .mockResolvedValueOnce({ requests: [request] });

    renderSpaceDetail({ listSpacePublicAdmissionRequests });
    await flushEffects();

    expect(listSpacePublicAdmissionRequests).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No pending join requests.")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushEffects();

    expect(listSpacePublicAdmissionRequests).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("stops refreshing after unmount", async () => {
    const listSpacePublicAdmissionRequests = vi.fn<NonNullable<SpaceDetailClient["listSpacePublicAdmissionRequests"]>>().mockResolvedValue({ requests: [] });
    const view = renderSpaceDetail({ listSpacePublicAdmissionRequests });
    await flushEffects();

    expect(listSpacePublicAdmissionRequests).toHaveBeenCalledTimes(1);
    view.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(listSpacePublicAdmissionRequests).toHaveBeenCalledTimes(1);
  });
});

function renderSpaceDetail(overrides: Pick<SpaceDetailClient, "listSpacePublicAdmissionRequests">) {
  const client: SpaceDetailClient = {
    getSpace: vi.fn().mockResolvedValue(space),
    listEpisodes: vi.fn().mockResolvedValue(episodes),
    ...overrides,
  };
  return render(<SpaceDetailPage tenantID="tenant-1" spaceID="space-1" client={client} />);
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
