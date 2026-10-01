/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAPIError } from "../../lib/dashboard-api";
import { AcceptInvitationPage } from "./AcceptInvitationPage";

const mocks = vi.hoisted(() => ({ accept: vi.fn(), account: vi.fn(), logout: vi.fn(), navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual("../../lib/dashboard-api");
  return { ...actual, acceptTenantInvitation: mocks.accept, getAccount: mocks.account, logoutAccount: mocks.logout };
});

const storage = vi.hoisted(() => new Map<string, string>());

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  mocks.account.mockResolvedValue({});
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/invitations/accept#token=secret-token");
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("AcceptInvitationPage", () => {
  it("posts the fragment token, removes it from the URL and opens the dashboard", async () => {
    mocks.accept.mockResolvedValue({ tenant_id: "tenant-1" });
    render(<AcceptInvitationPage />);

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/home", replace: true }));
    expect(mocks.accept).toHaveBeenCalledWith("secret-token");
    expect(storage.get("chalk.tenant-hint")).toBe("tenant-1");
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem("chalk.invitation-token")).toBeNull();
  });

  it("asks for a new invitation on 410", async () => {
    mocks.accept.mockRejectedValue(new DashboardAPIError(410, "invitation.unavailable", "invitation is expired, revoked or already used; ask an Owner for a new invitation"));
    render(<AcceptInvitationPage />);

    expect(await screen.findByText("This invitation no longer works.")).toBeTruthy();
    expect(screen.getByText(/ask an Owner for a new invitation/)).toBeTruthy();
    expect(screen.getByText(/Ask a Tenant admin to send you a new invitation/)).toBeTruthy();
  });

  it("offers to switch Account on 403 and keeps the token for the return trip", async () => {
    mocks.accept.mockRejectedValue(new DashboardAPIError(403, "invitation.wrong_account", "this invitation belongs to another email"));
    mocks.logout.mockResolvedValue(undefined);
    render(<AcceptInvitationPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out and switch Account" }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/sign-in", search: { next: "/invitations/accept" }, replace: true }));
    expect(mocks.logout).toHaveBeenCalled();
    expect(window.sessionStorage.getItem("chalk.invitation-token")).toBe("secret-token");
  });

  it("sends a signed-out visitor to sign in and keeps the token", async () => {
    mocks.account.mockRejectedValue(new DashboardAPIError(401, "access.unauthenticated", "Sign in required"));
    render(<AcceptInvitationPage />);

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/sign-in", search: { next: "/invitations/accept" }, replace: true }));
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("chalk.invitation-token")).toBe("secret-token");
  });
});
