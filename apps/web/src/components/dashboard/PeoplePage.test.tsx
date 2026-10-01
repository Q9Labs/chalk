/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PeoplePage } from "./PeoplePage";

const mocks = vi.hoisted(() => ({ listMemberships: vi.fn(), listInvitations: vi.fn(), useDashboardAccount: vi.fn() }));

vi.mock("../../lib/dashboard-api", () => ({
  DashboardAPIError: class DashboardAPIError extends Error {},
  leaveTenant: vi.fn(),
  listMemberships: mocks.listMemberships,
  listTenantInvitations: mocks.listInvitations,
  removeMembership: vi.fn(),
  revokeTenantInvitation: vi.fn(),
  updateMembershipRole: vi.fn(),
}));
vi.mock("./DashboardAccount", () => ({ useDashboardAccount: mocks.useDashboardAccount }));
vi.mock("./DashboardShell", () => ({ Icon: () => null }));
vi.mock("./InvitePeopleDialog", () => ({ InvitePeopleDialog: () => null }));

const membership = {
  id: "33333333-3333-4333-8333-333333333333",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  user_id: "22222222-2222-4222-8222-222222222222",
  user_name: "Alex Smith",
  user_email: "alex@example.test",
  role: "observer" as const,
  updated_at: "2026-10-01T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  mocks.useDashboardAccount.mockReturnValue({
    account: { id: "44444444-4444-4444-8444-444444444444", name: "Owner", email: "owner@example.test" },
    current: { tenant: { id: membership.tenant_id, name: "Acme" }, access: { role: "owner" } },
  });
  mocks.listInvitations.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PeoplePage member identity", () => {
  it("shows the member name with their email underneath", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [membership], pagination: { page_size: 50, has_more: false } });
    render(<PeoplePage />);

    expect(await screen.findByRole("heading", { name: "Alex Smith" })).toBeTruthy();
    expect(screen.getByText("alex@example.test")).toBeTruthy();
    expect(screen.queryByText(membership.user_id)).toBeNull();
  });

  it("falls back to the user ID only when name and email are empty", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [{ ...membership, user_name: "", user_email: "" }], pagination: { page_size: 50, has_more: false } });
    render(<PeoplePage />);

    expect(await screen.findByRole("heading", { name: membership.user_id })).toBeTruthy();
  });
});
