// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAPIError, updateSpace } from "../../lib/dashboard-api";
import { dashboardTestSpace as space, dashboardTestTenantID as tenantID, installDialogMethods } from "./__tests__/dialog-fixtures";
import { EditSpaceDialog } from "./EditSpaceDialog";

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dashboard-api")>("../../lib/dashboard-api");
  return { ...actual, updateSpace: vi.fn() };
});

const updateSpaceMock = vi.mocked(updateSpace);

beforeEach(() => {
  installDialogMethods();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("EditSpaceDialog", () => {
  it("hydrates fields, normalizes edits, and saves the selected admission policy", async () => {
    const current = space({ admission_policy: { mode: "knock" } });
    const saved = space({ name: "Research", slug: "research", admission_policy: { mode: "open" } });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    updateSpaceMock.mockResolvedValue(saved);

    render(<EditSpaceDialog open tenantID={tenantID} space={current} onClose={onClose} onSaved={onSaved} />);

    const nameInput = (await screen.findByLabelText("Space name")) as HTMLInputElement;
    const slugInput = screen.getByLabelText("Join slug") as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe("Product studio"));
    expect(slugInput.value).toBe("product-studio");
    expect((screen.getByRole("radio", { name: /Ask to join/ }) as HTMLInputElement).checked).toBe(true);

    fireEvent.change(nameInput, { target: { value: "  Research  " } });
    fireEvent.change(slugInput, { target: { value: " Research & Notes " } });
    fireEvent.click(screen.getByRole("radio", { name: /^Open/ }));
    fireEvent.submit(nameInput.closest("form")!);

    await waitFor(() =>
      expect(updateSpaceMock).toHaveBeenCalledWith({
        tenantID,
        spaceID: current.id,
        name: "Research",
        slug: "research-notes",
        admission_policy: { mode: "open" },
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not offer unsupported members-only enforcement", async () => {
    render(<EditSpaceDialog open tenantID={tenantID} space={space({ admission_policy: { mode: "members_only" } })} onClose={() => undefined} />);

    expect((await screen.findByRole("status")).textContent).toContain("membership enforcement is not available yet");
    expect(screen.queryByRole("radio", { name: /Members only/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Ask to join/ }));
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows an API error and keeps the dialog open when saving fails", async () => {
    const onClose = vi.fn();
    updateSpaceMock.mockRejectedValue(new DashboardAPIError(409, "space_slug_taken", "That join slug is already in use."));

    render(<EditSpaceDialog open tenantID={tenantID} space={space()} onClose={onClose} />);

    const nameInput = (await screen.findByLabelText("Space name")) as HTMLInputElement;
    fireEvent.submit(nameInput.closest("form")!);

    expect((await screen.findByRole("alert")).textContent).toContain("That join slug is already in use.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(false);
  });
});
