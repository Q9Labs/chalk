// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardEpisode, DashboardSpace } from "../../lib/dashboard-api";
import { EndEpisodeDialog, StartEpisodeDialog } from "./EpisodeDialogs";

function space(overrides: Partial<DashboardSpace> = {}): DashboardSpace {
  return {
    id: "space-1",
    tenant_id: "tenant-1",
    name: "Product studio",
    slug: "product-studio",
    media_plane: "cf_rtk",
    metadata: {},
    recurring_policy: null,
    admission_policy: "open",
    default_episode_duration_seconds: 3600,
    maximum_episode_duration_seconds: 86_400,
    linger_window_seconds: 45,
    archived: false,
    archived_at: null,
    roles: [],
    created_by_user_id: null,
    updated_at: "2026-08-04T09:00:00Z",
    created_at: "2026-08-04T09:00:00Z",
    ...overrides,
  };
}

function episode(overrides: Partial<DashboardEpisode> = {}): DashboardEpisode {
  return {
    id: "episode-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    status: "active",
    metadata: {},
    config_snapshot: {},
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

describe("StartEpisodeDialog", () => {
  it("opens, selects a Space, submits, and closes through its callbacks", () => {
    const onClose = vi.fn();
    const onSpaceChange = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault());
    const { rerender } = render(<StartEpisodeDialog open spaces={[space(), space({ id: "space-2", name: "Research" })]} selectedSpaceID="space-1" busy={false} error={null} onClose={onClose} onSpaceChange={onSpaceChange} onSubmit={onSubmit} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("option", { name: "Product studio" })).toHaveProperty("selected", true);
    fireEvent.change(screen.getByLabelText("Space"), { target: { value: "space-2" } });
    expect(onSpaceChange).toHaveBeenCalledWith("space-2");

    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<StartEpisodeDialog open={false} spaces={[space()]} selectedSpaceID="space-1" busy={false} error={null} onClose={onClose} onSpaceChange={onSpaceChange} onSubmit={onSubmit} />);
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("communicates a start error and disables controls while busy", () => {
    render(<StartEpisodeDialog open spaces={[space()]} selectedSpaceID="" busy error="The Episode could not start" onClose={vi.fn()} onSpaceChange={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toContain("The Episode could not start");
    expect(screen.getByLabelText("Space")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Starting…" })).toHaveProperty("disabled", true);
  });
});

describe("EndEpisodeDialog", () => {
  it("warns when an Episode is already ending and confirms the operation", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<EndEpisodeDialog open episode={episode({ status: "ending" })} busy={false} error={null} onClose={onClose} onConfirm={onConfirm} />);

    expect(screen.getByText(/already ending/)).toBeTruthy();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form") as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Keep it live" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows an end error and prevents duplicate confirmation while busy", () => {
    const onConfirm = vi.fn();
    render(<EndEpisodeDialog open episode={episode()} busy error="Ending is unavailable" onClose={vi.fn()} onConfirm={onConfirm} />);

    expect(screen.getByRole("alert").textContent).toContain("Ending is unavailable");
    expect(screen.getByRole("button", { name: "Keep it live" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Ending…" })).toHaveProperty("disabled", true);
    fireEvent.submit(screen.getByRole("dialog").querySelector("form") as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
