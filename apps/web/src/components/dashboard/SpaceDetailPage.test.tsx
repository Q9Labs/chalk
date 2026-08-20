// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAPIError, archiveSpace, restoreSpace, updateSpace, type DashboardEpisode, type DashboardPublicAdmissionRequest, type DashboardSpacePublicInvite } from "../../lib/dashboard-api";
import { dashboardTestSpace as makeSpace, dashboardTestTenantID as tenantID, installDialogMethods } from "./__tests__/dialog-fixtures";
import { SpaceDetailPage, type SpaceDetailClient } from "./SpaceDetailPage";

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dashboard-api")>("../../lib/dashboard-api");
  return { ...actual, archiveSpace: vi.fn(), restoreSpace: vi.fn(), updateSpace: vi.fn() };
});

const archiveSpaceMock = vi.mocked(archiveSpace);
const restoreSpaceMock = vi.mocked(restoreSpace);
const updateSpaceMock = vi.mocked(updateSpace);

function episode(overrides: Partial<DashboardEpisode> = {}): DashboardEpisode {
  return {
    id: "episode-1",
    tenant_id: tenantID,
    space_id: "space-1",
    status: "ended",
    metadata: {},
    config_snapshot: {},
    started_at: "2026-08-04T10:00:00Z",
    ended_at: "2026-08-04T10:25:00Z",
    end_reason: "requested",
    deadline_at: "2026-08-04T11:00:00Z",
    deadline_generation: 1,
    updated_at: "2026-08-04T10:25:00Z",
    created_at: "2026-08-04T10:00:00Z",
    ...overrides,
  };
}

function clientFor(space = makeSpace(), episodes = [episode()]): SpaceDetailClient {
  return {
    getSpace: vi.fn().mockResolvedValue(space),
    listEpisodes: vi.fn().mockResolvedValue({ episodes, pagination: { page_size: 10, next_cursor: null, has_more: false } }),
  };
}

function publicInvite(overrides: Partial<DashboardSpacePublicInvite> = {}): DashboardSpacePublicInvite {
  return {
    schema_version: "cspi1",
    tenant_id: tenantID,
    space_id: "space-1",
    enabled: true,
    generation: 1,
    public_role: "collaborator",
    admission_mode: "open",
    created_at: "2026-08-04T00:00:00Z",
    updated_at: "2026-08-04T00:00:00Z",
    canonical_url: "https://app.chalk.test/space/product-studio#spaceInviteToken=cspi1.public-1.payload.signature",
    ...overrides,
  };
}

function admissionRequest(overrides: Partial<DashboardPublicAdmissionRequest> = {}): DashboardPublicAdmissionRequest {
  return {
    request_handle: "request-handle-1",
    display_name: "Ada",
    requested_at: "2026-08-04T10:00:00Z",
    expires_at: "2026-08-04T10:05:00Z",
    state: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  installDialogMethods();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("SpaceDetailPage", () => {
  it("keeps the participant Join Space link separate from dashboard details", async () => {
    const { container } = render(<SpaceDetailPage tenantID={tenantID} spaceID="space-1" client={clientFor()} />);

    expect(await screen.findByRole("heading", { name: "Product studio" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Join Space" }).getAttribute("href")).toBe("/space/product-studio?entry=dashboard");
    expect(screen.getByRole("link", { name: "Spaces" }).getAttribute("href")).toBe("/spaces");
    expect(screen.getByRole("link", { name: "Join Space" }).getAttribute("href")).not.toContain("/spaces/");
    expect(screen.getByText("Tenant access")).toBeTruthy();
    expect(container.querySelector(".eyebrow")).toBeNull();
  });

  it("hides Join Space and offers Restore for an archived Space", async () => {
    render(<SpaceDetailPage tenantID={tenantID} spaceID="space-1" client={clientFor(makeSpace({ archived: true, archived_at: "2026-08-04T12:00:00Z" }))} />);

    expect(await screen.findByText("Archived")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Join Space" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(await screen.findByText("Public links are unavailable while this Space is archived.")).toBeTruthy();
  });

  it("renders the public invite and knock request panel headings", async () => {
    render(
      <SpaceDetailPage
        tenantID={tenantID}
        spaceID="space-1"
        client={{
          ...clientFor(makeSpace({ admission_policy: { mode: "knock" } })),
          getSpacePublicInvite: vi.fn().mockResolvedValue(publicInvite({ admission_mode: "knock" })),
          listSpacePublicAdmissionRequests: vi.fn().mockResolvedValue({ requests: [] }),
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Public link" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pending join requests" })).toBeTruthy();
  });

  it("loads, copies, disables, re-enables, and rotates a public link", async () => {
    const invite = publicInvite();
    const getSpacePublicInvite = vi.fn().mockResolvedValue(invite);
    const updateSpacePublicInvite = vi.fn().mockImplementation(({ enabled }: { enabled: boolean }) => Promise.resolve({ ...invite, enabled }));
    const rotateSpacePublicInvite = vi.fn().mockResolvedValue({ ...invite, generation: 2, canonical_url: "https://app.chalk.test/space/product-studio#spaceInviteToken=cspi1.public-1.rotated.signature" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SpaceDetailPage tenantID={tenantID} spaceID="space-1" client={{ ...clientFor(), getSpacePublicInvite, updateSpacePublicInvite, rotateSpacePublicInvite }} />);

    expect(await screen.findByDisplayValue(invite.canonical_url)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(invite.canonical_url));
    fireEvent.click(screen.getByRole("button", { name: "Disable link" }));
    await waitFor(() => expect(updateSpacePublicInvite).toHaveBeenCalledWith({ tenantID, spaceID: "space-1", enabled: false }));
    expect(await screen.findByRole("button", { name: "Re-enable link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-enable link" }));
    await waitFor(() => expect(updateSpacePublicInvite).toHaveBeenCalledWith({ tenantID, spaceID: "space-1", enabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate link" }));
    expect(await screen.findByRole("heading", { name: "Rotate public link?" })).toBeTruthy();
    const rotateButtons = screen.getAllByRole("button", { name: "Rotate link" });
    const rotateButton = rotateButtons.at(-1);
    if (!rotateButton) throw new Error("Rotate confirmation button was not rendered.");
    fireEvent.click(rotateButton);
    await waitFor(() => expect(rotateSpacePublicInvite).toHaveBeenCalledWith({ tenantID, spaceID: "space-1" }));
    expect(await screen.findByDisplayValue("https://app.chalk.test/space/product-studio#spaceInviteToken=cspi1.public-1.rotated.signature")).toBeTruthy();
  });

  it("shows a members-only public link state", async () => {
    const getSpacePublicInvite = vi.fn();
    render(<SpaceDetailPage tenantID={tenantID} spaceID="space-1" client={{ ...clientFor(makeSpace({ admission_policy: { mode: "members_only" } })), getSpacePublicInvite }} />);

    expect(await screen.findByText("Public links are unavailable for members-only Spaces.")).toBeTruthy();
    expect(getSpacePublicInvite).not.toHaveBeenCalled();
  });

  it("lists and decides pending knock requests", async () => {
    const request = admissionRequest();
    const listSpacePublicAdmissionRequests = vi.fn().mockResolvedValue({ requests: [request] });
    const approveSpacePublicAdmissionRequest = vi.fn().mockResolvedValue({ ...request, state: "approved" });
    const denySpacePublicAdmissionRequest = vi.fn().mockResolvedValue({ ...request, state: "denied" });
    render(
      <SpaceDetailPage
        tenantID={tenantID}
        spaceID="space-1"
        client={{
          ...clientFor(makeSpace({ admission_policy: { mode: "knock" } })),
          getSpacePublicInvite: vi.fn().mockResolvedValue(publicInvite({ admission_mode: "knock" })),
          listSpacePublicAdmissionRequests,
          approveSpacePublicAdmissionRequest,
          denySpacePublicAdmissionRequest,
        }}
      />,
    );

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve Ada" }));
    await waitFor(() => expect(approveSpacePublicAdmissionRequest).toHaveBeenCalledWith({ tenantID, spaceID: "space-1", requestHandle: request.request_handle }));
    expect(screen.queryByText("Ada")).toBeNull();
    expect(denySpacePublicAdmissionRequest).not.toHaveBeenCalled();
  });

  it("links each recent Episode to its filtered history", async () => {
    const episodes = [episode(), episode({ id: "episode-2", started_at: "2026-08-04T09:00:00Z" })];
    render(<SpaceDetailPage tenantID={tenantID} spaceID="space-1" client={clientFor(makeSpace(), episodes)} />);

    await screen.findByRole("heading", { name: "Recent Episodes" });
    const episodeLinks = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/episodes?space=space-1&episode="));
    expect(episodeLinks).toHaveLength(2);
    expect(episodeLinks.map((link) => link.getAttribute("href"))).toEqual(["/episodes?space=space-1&episode=episode-1", "/episodes?space=space-1&episode=episode-2"]);
  });

  it("uses the existing edit and lifecycle dialogs", async () => {
    const current = makeSpace();
    const changed = makeSpace({ name: "Renamed studio", slug: "renamed-studio", archived: true, archived_at: "2026-08-04T12:00:00Z" });
    updateSpaceMock.mockResolvedValue({ ...current, name: "Renamed studio", slug: "renamed-studio" });
    archiveSpaceMock.mockResolvedValue(changed);
    render(<SpaceDetailPage tenantID={tenantID} spaceID="space-1" client={clientFor(current)} />);

    await screen.findByRole("heading", { name: "Product studio" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("heading", { name: "Edit Space" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByRole("heading", { name: "Archive this Space?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive Space" }));

    await waitFor(() => expect(archiveSpaceMock).toHaveBeenCalledWith({ tenantID, spaceID: current.id }));
    expect(screen.queryByRole("link", { name: "Join Space" })).toBeNull();
    expect(restoreSpaceMock).not.toHaveBeenCalled();
  });

  it("shows a retryable error state and reloads both resources", async () => {
    const getSpace = vi.fn().mockRejectedValueOnce(new Error("Network down")).mockResolvedValueOnce(makeSpace());
    const listEpisodes = vi.fn().mockResolvedValue({ episodes: [], pagination: { page_size: 10, next_cursor: null, has_more: false } });
    const client: SpaceDetailClient = { getSpace, listEpisodes };
    render(<SpaceDetailPage tenantID={tenantID} spaceID="space-1" client={client} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Network down");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Product studio" })).toBeTruthy();
    expect(getSpace).toHaveBeenCalledTimes(2);
    expect(listEpisodes).toHaveBeenCalledTimes(2);
  });

  it("uses a safe not-found state for a missing Space", async () => {
    const client: SpaceDetailClient = {
      getSpace: vi.fn().mockRejectedValue(new DashboardAPIError(404, "space.not_found", "Space not found")),
      listEpisodes: vi.fn().mockResolvedValue({ episodes: [], pagination: { page_size: 10, next_cursor: null, has_more: false } }),
    };
    render(<SpaceDetailPage tenantID={tenantID} spaceID="missing" client={client} />);

    expect(await screen.findByRole("heading", { name: "That Space is not available." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Spaces" }).getAttribute("href")).toBe("/spaces");
  });
});
