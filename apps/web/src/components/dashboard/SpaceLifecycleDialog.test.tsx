// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSpace, DashboardAPIError, restoreSpace } from "../../lib/dashboard-api";
import { dashboardTestSpace as space, dashboardTestTenantID as tenantID, installDialogMethods } from "./__tests__/dialog-fixtures";
import { SpaceLifecycleDialog } from "./SpaceLifecycleDialog";

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dashboard-api")>("../../lib/dashboard-api");
  return { ...actual, archiveSpace: vi.fn(), restoreSpace: vi.fn() };
});

const archiveSpaceMock = vi.mocked(archiveSpace);
const restoreSpaceMock = vi.mocked(restoreSpace);

beforeEach(() => {
  installDialogMethods();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("SpaceLifecycleDialog", () => {
  it("archives the selected Space after confirmation", async () => {
    const current = space();
    const changed = space({ archived: true, archived_at: "2026-08-04T10:00:00Z" });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    archiveSpaceMock.mockResolvedValue(changed);

    render(<SpaceLifecycleDialog open tenantID={tenantID} space={current} action="archive" onClose={onClose} onChanged={onChanged} />);

    expect(screen.getByRole("heading", { name: "Archive this Space?" })).toBeTruthy();
    expect(screen.getByText(/New Episodes and joins stop/)).toBeTruthy();
    expect(screen.getByText("Product studio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive Space" }));

    await waitFor(() => expect(archiveSpaceMock).toHaveBeenCalledWith({ tenantID, spaceID: current.id }));
    expect(onChanged).toHaveBeenCalledWith(changed);
    expect(onClose).toHaveBeenCalledOnce();
    expect(restoreSpaceMock).not.toHaveBeenCalled();
  });

  it("restores the selected Space and surfaces API failures without closing", async () => {
    const onChanged = vi.fn();
    const onClose = vi.fn();
    restoreSpaceMock.mockRejectedValue(new DashboardAPIError(409, "space_not_archived", "This Space is already active."));

    render(<SpaceLifecycleDialog open tenantID={tenantID} space={space({ archived: true, archived_at: "2026-08-04T10:00:00Z" })} action="restore" onClose={onClose} onChanged={onChanged} />);

    expect(screen.getByRole("heading", { name: "Restore this Space?" })).toBeTruthy();
    expect(screen.getByText(/becomes joinable again/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore Space" }));

    await waitFor(() => expect(restoreSpaceMock).toHaveBeenCalledWith({ tenantID, spaceID: "space-1" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This Space is already active.");
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restore Space" }).hasAttribute("disabled")).toBe(false);
  });
});
