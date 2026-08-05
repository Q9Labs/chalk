// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardEpisode } from "../../lib/dashboard-api";
import { EpisodeDetailPanel } from "./EpisodeDetail";

function episode(overrides: Partial<DashboardEpisode> = {}): DashboardEpisode {
  return {
    id: "episode-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    status: "active",
    metadata: { source: "test" },
    config_snapshot: { admission_policy: "open", linger_window_seconds: 45 },
    end_reason: null,
    started_at: "2026-08-04T09:00:00Z",
    ended_at: null,
    deadline_at: "2026-08-04T11:00:00Z",
    deadline_generation: 0,
    updated_at: "2026-08-04T09:00:00Z",
    created_at: "2026-08-04T09:00:00Z",
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("EpisodeDetailPanel", () => {
  it("shows a loading snapshot and exposes close behavior", () => {
    const onClose = vi.fn();
    render(<EpisodeDetailPanel episode={null} spaceName="Product studio" state="loading" error={null} onRetry={vi.fn()} onClose={onClose} onEnd={vi.fn()} />);

    expect(screen.getByRole("complementary", { name: "Episode details" })).toBeTruthy();
    expect(screen.getByText("Loading the immutable snapshot…")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Product studio" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Episode details" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders a retryable error without showing stale episode data", () => {
    const onRetry = vi.fn();
    render(<EpisodeDetailPanel episode={episode()} spaceName="Product studio" state="error" error="The detail request failed" onRetry={onRetry} onClose={vi.fn()} onEnd={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toContain("The detail request failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByText("Config snapshot")).toBeNull();
  });

  it("renders an active Episode snapshot and allows ending it", () => {
    const onEnd = vi.fn();
    render(<EpisodeDetailPanel episode={episode()} spaceName="Product studio" state="ready" error={null} onRetry={vi.fn()} onClose={vi.fn()} onEnd={onEnd} />);

    expect(screen.getByText("Live now")).toBeTruthy();
    expect(screen.getByText("Deadline")).toBeTruthy();
    expect(screen.getByText(/admission_policy/)).toBeTruthy();
    expect(screen.getByText(/source/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End Episode" }));
    expect(onEnd).toHaveBeenCalledOnce();
    expect(screen.queryByText("Immutable history")).toBeNull();
  });

  it("marks ended Episodes as immutable and shows their end reason", () => {
    render(<EpisodeDetailPanel episode={episode({ status: "ended", ended_at: "2026-08-04T09:42:00Z", end_reason: "deadline_exceeded" })} spaceName="Product studio" state="ready" error={null} onRetry={vi.fn()} onClose={vi.fn()} onEnd={vi.fn()} />);

    expect(screen.getAllByText("Ended")).toHaveLength(2);
    expect(screen.getByText("Immutable history")).toBeTruthy();
    expect(screen.getByText("Deadline Exceeded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End Episode" })).toBeNull();
  });
});
