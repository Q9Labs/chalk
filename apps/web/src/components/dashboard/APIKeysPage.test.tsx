// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIKeysPage } from "./APIKeysPage";
import { dashboardSource } from "./__tests__/source";
import type { DashboardAPIKey } from "../../lib/dashboard-api";

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dashboard-api")>("../../lib/dashboard-api");
  return { ...actual, createAPIKey: vi.fn(), listAPIKeys: vi.fn(), startRecentAuthGoogle: vi.fn() };
});

import * as dashboardAPI from "../../lib/dashboard-api";

const tenantID = "tenant-1";

function apiKey(overrides: Partial<DashboardAPIKey> = {}): DashboardAPIKey {
  return {
    id: "key-1",
    tenant_id: tenantID,
    name: "Production backend",
    scopes: ["spaces:read"],
    key_prefix: "chalk_pk_test",
    created_by_user_id: "account-1",
    last_used_at: null,
    revoked_at: null,
    expires_at: "2030-01-01T00:00:00Z",
    updated_at: "2026-08-04T00:00:00Z",
    created_at: "2026-08-04T00:00:00Z",
    ...overrides,
  };
}

function page(keys: DashboardAPIKey[], next_cursor: string | null, has_more: boolean) {
  return { api_keys: keys, pagination: { page_size: 25, next_cursor, has_more } };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  if (!HTMLDialogElement.prototype.showModal)
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value() {
        this.open = true;
      },
    });
  if (!HTMLDialogElement.prototype.close)
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value() {
        this.open = false;
      },
    });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("API keys page", () => {
  it("keeps Developer management on the shared dashboard shell contract", () => {
    const markup = renderToStaticMarkup(<APIKeysPage tenantID="tenant-1" />);
    expect(markup).toContain("Developer");
    expect(markup).toContain("API keys");
    expect(markup).toContain("New API key");
    expect(markup).toContain("Secrets appear once");
  });

  it("offers the Alpha Episode Debugger when hosted diagnostics are enabled", () => {
    vi.stubGlobal("__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__", true);
    vi.mocked(dashboardAPI.listAPIKeys).mockResolvedValue(page([], null, false));
    render(<APIKeysPage tenantID="tenant-1" />);

    expect(screen.getByRole("heading", { name: "Episode Debugger" })).toBeTruthy();
    expect(screen.getByLabelText("Diagnostic reference")).toBeTruthy();
  });

  it("documents one-time secret handling and step-up controls in the UI", () => {
    const source = dashboardSource("APIKeysPage.tsx");
    expect(source).toContain("One-time secret");
    expect(source).toContain("Copy secret");
    expect(source).toContain("Dashboard password");
    expect(source).toContain("revokeAPIKey");
    expect(source).toContain("requestKey: newIdempotencyKey()");
    expect(source).toContain("api_key.secret_not_replayable");
    expect(source).toContain("Continue with Google");
    expect(source).toContain("event.origin !== window.location.origin");
    expect(source).toContain("PENDING_MUTATION_STORAGE_KEY");
  });

  it("uses honest cursor controls to reach keys beyond the first page", async () => {
    const listAPIKeys = vi.mocked(dashboardAPI.listAPIKeys);
    listAPIKeys
      .mockResolvedValueOnce(page([apiKey({ name: "Newest key" })], "cursor-2", true))
      .mockResolvedValueOnce(page([apiKey({ id: "key-26", name: "Older key" })], null, false))
      .mockResolvedValueOnce(page([apiKey({ name: "Newest key" })], "cursor-2", true));

    render(<APIKeysPage tenantID={tenantID} />);

    expect(await screen.findByText("Newest key")).toBeTruthy();
    expect(listAPIKeys).toHaveBeenNthCalledWith(1, tenantID, { cursor: undefined, pageSize: 25 });
    fireEvent.click(screen.getByRole("button", { name: "Older keys" }));

    expect(await screen.findByText("Older key")).toBeTruthy();
    expect(listAPIKeys).toHaveBeenNthCalledWith(2, tenantID, { cursor: "cursor-2", pageSize: 25 });
    fireEvent.click(screen.getByRole("button", { name: "Newer keys" }));

    await waitFor(() => expect(listAPIKeys).toHaveBeenNthCalledWith(3, tenantID, { cursor: undefined, pageSize: 25 }));
    expect(await screen.findByText("Newest key")).toBeTruthy();
  });

  it("shows a retryable inventory error when a later page fails", async () => {
    const listAPIKeys = vi.mocked(dashboardAPI.listAPIKeys);
    listAPIKeys
      .mockResolvedValueOnce(page([apiKey({ name: "Newest key" })], "cursor-2", true))
      .mockRejectedValueOnce(new Error("inventory unavailable"))
      .mockResolvedValueOnce(page([], null, false));

    render(<APIKeysPage tenantID={tenantID} />);

    expect(await screen.findByText("Newest key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Older keys" }));
    expect((await screen.findByRole("alert")).textContent).toContain("inventory unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listAPIKeys).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("No API keys on this page")).toBeTruthy();
  });

  it("resets tenant-scoped inventory and mutation state when the tenant changes", async () => {
    const listAPIKeys = vi.mocked(dashboardAPI.listAPIKeys);
    listAPIKeys.mockResolvedValue(page([apiKey()], "cursor-2", true));

    const view = render(<APIKeysPage tenantID="tenant-1" />);
    await screen.findByText("Production backend");
    fireEvent.click(screen.getByRole("button", { name: "Older keys" }));
    await waitFor(() => expect(listAPIKeys).toHaveBeenCalledWith("tenant-1", { cursor: "cursor-2", pageSize: 25 }));

    fireEvent.click(screen.getByRole("button", { name: "New API key" }));
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Tenant one key" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Confirm with your password" })).toBeTruthy();

    view.rerender(<APIKeysPage tenantID="tenant-2" />);
    await waitFor(() => expect(listAPIKeys).toHaveBeenCalledWith("tenant-2", { cursor: undefined, pageSize: 25 }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Confirm with your password" })).toBeNull());
    expect(screen.queryByText("Tenant one key")).toBeNull();
  });

  it("does not allow revoking an expired key", async () => {
    const listAPIKeys = vi.mocked(dashboardAPI.listAPIKeys);
    listAPIKeys.mockResolvedValue(page([apiKey({ expires_at: "2020-01-01T00:00:00Z" })], null, false));

    render(<APIKeysPage tenantID={tenantID} />);

    const revoke = (await screen.findByRole("button", { name: "Revoke Production backend" })) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
  });

  it("finishes an OAuth-only API-key mutation from a same-origin popup message", async () => {
    const listAPIKeys = vi.mocked(dashboardAPI.listAPIKeys);
    const startRecentAuthGoogle = vi.mocked(dashboardAPI.startRecentAuthGoogle);
    const createAPIKey = vi.mocked(dashboardAPI.createAPIKey);
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    listAPIKeys.mockResolvedValue(page([apiKey()], null, false));
    startRecentAuthGoogle.mockResolvedValue({ authorization_url: "https://accounts.google.test/oauth", state: "opaque-state" });
    createAPIKey.mockResolvedValue({ api_key: apiKey({ id: "key-new" }), secret: "secret-once" });
    vi.spyOn(window, "open").mockReturnValue(popup);

    render(<APIKeysPage tenantID={tenantID} />);
    await screen.findByText("Production backend");
    fireEvent.click(screen.getByRole("button", { name: "New API key" }));
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "OAuth backend" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Confirm with your password" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(startRecentAuthGoogle).toHaveBeenCalledWith({ action: "api_key.create", resource_id: tenantID }));
    const stored = window.sessionStorage.getItem("chalk.api-key.pending-recent-auth");
    expect(stored).toContain("OAuth backend");
    expect(stored).not.toContain("opaque-proof");
    expect(stored).not.toContain("secret-once");

    const rejected = new MessageEvent("message", { origin: "https://evil.test", data: { type: "chalk.recent-auth.google.complete", proof: "evil-proof", expires_at: "2030-01-01T00:00:00Z" } });
    Object.defineProperty(rejected, "source", { value: popup });
    window.dispatchEvent(rejected);
    expect(createAPIKey).not.toHaveBeenCalled();

    const completed = new MessageEvent("message", { origin: window.location.origin, data: { type: "chalk.recent-auth.google.complete", proof: "opaque-proof", expires_at: "2030-01-01T00:00:00Z" } });
    Object.defineProperty(completed, "source", { value: popup });
    window.dispatchEvent(completed);

    await waitFor(() => expect(createAPIKey).toHaveBeenCalledWith(tenantID, expect.objectContaining({ name: "OAuth backend" }), expect.objectContaining({ recentAuth: "opaque-proof" })));
    await waitFor(() => expect(window.sessionStorage.getItem("chalk.api-key.pending-recent-auth")).toBeNull());
    expect(await screen.findByText("API key created")).toBeTruthy();
  });
});
