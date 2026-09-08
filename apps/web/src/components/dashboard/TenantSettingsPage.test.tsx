/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAPIError } from "../../lib/dashboard-api";
import { TenantSettingsPage } from "./TenantSettingsPage";

const mocks = vi.hoisted(() => ({
  updateTenant: vi.fn(),
  updateCurrentTenant: vi.fn(),
  useDashboardAccount: vi.fn(),
}));

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual("../../lib/dashboard-api");
  return { ...actual, updateTenantCORSAllowedOrigins: mocks.updateTenant };
});

vi.mock("./DashboardAccount", () => ({ useDashboardAccount: mocks.useDashboardAccount }));

beforeEach(() => {
  mocks.useDashboardAccount.mockReturnValue({
    current: {
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Acme Lab", default_region: "us", cors_allowed_origins: [] },
      access: { role: "owner" },
    },
    updateCurrentTenant: mocks.updateCurrentTenant,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Tenant CORS settings", () => {
  it("keeps invalid input visible when the API rejects it", async () => {
    mocks.updateTenant.mockRejectedValue(new DashboardAPIError(400, "tenant.invalid_cors_origin", "Use an HTTPS origin, or HTTP only for localhost."));
    render(<TenantSettingsPage />);

    const input = screen.getByLabelText("One origin per line");
    fireEvent.change(input, { target: { value: "http://app.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allowed origins" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Use an HTTPS origin, or HTTP only for localhost.");
    expect(input).toHaveProperty("value", "http://app.example.com");
  });

  it("saves and displays the canonical origin list", async () => {
    const tenant = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Acme Lab",
      default_region: "us",
      cors_allowed_origins: ["http://localhost:3070", "https://app.example.com"],
    };
    mocks.updateTenant.mockResolvedValue(tenant);
    render(<TenantSettingsPage />);

    fireEvent.change(screen.getByLabelText("One origin per line"), { target: { value: "https://app.example.com\nhttp://localhost:3070" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allowed origins" }));

    await waitFor(() => expect(mocks.updateCurrentTenant).toHaveBeenCalledWith(tenant));
    expect(screen.getByRole("status").textContent).toContain("Tenant CORS policy saved.");
    expect(screen.getByLabelText("One origin per line")).toHaveProperty("value", "http://localhost:3070\nhttps://app.example.com");
  });

  it("does not apply a completed save to a newly selected Tenant", async () => {
    let resolveSave: (tenant: { id: string; name: string; default_region: string; cors_allowed_origins: string[] }) => void = () => undefined;
    mocks.updateTenant.mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
    const { rerender } = render(<TenantSettingsPage />);
    fireEvent.change(screen.getByLabelText("One origin per line"), { target: { value: "https://first.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allowed origins" }));

    mocks.useDashboardAccount.mockReturnValue({
      current: {
        tenant: { id: "22222222-2222-4222-8222-222222222222", name: "Second Lab", default_region: "eu", cors_allowed_origins: ["https://second.example"] },
        access: { role: "owner" },
      },
      updateCurrentTenant: mocks.updateCurrentTenant,
    });
    rerender(<TenantSettingsPage />);
    resolveSave({ id: "11111111-1111-4111-8111-111111111111", name: "Acme Lab", default_region: "us", cors_allowed_origins: ["https://first.example"] });

    await waitFor(() => expect(screen.getByRole("button", { name: "Save allowed origins" })).toHaveProperty("disabled", false));
    expect(screen.getByLabelText("One origin per line")).toHaveProperty("value", "https://second.example");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
