// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localValues = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return localValues.size;
  },
  clear: () => localValues.clear(),
  getItem: (key) => localValues.get(key) ?? null,
  key: (index) => Array.from(localValues.keys())[index] ?? null,
  removeItem: (key) => localValues.delete(key),
  setItem: (key, value) => localValues.set(key, value),
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: testStorage });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  vi.resetModules();
});

describe("dashboard API client", () => {
  it("bootstraps CSRF and emits journey plus W3C trace context for sign-in", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-token" }))
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1", name: "Hasan", email: "hasan@example.com", updated_at: "2026-08-04T00:00:00Z", created_at: "2026-08-04T00:00:00Z" } }));
    vi.stubGlobal("fetch", fetcher);
    const { loginAccount } = await import("./dashboard-api");

    await expect(loginAccount({ email: "hasan@example.com", password: "password-1" })).resolves.toMatchObject({ id: "account-1" });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/auth/csrf", expect.objectContaining({ credentials: "same-origin" }));
    const [, request] = fetcher.mock.calls[1] as [string, RequestInit];
    const headers = new Headers(request.headers);
    expect(headers.get("x-chalk-csrf")).toBe("csrf-token");
    expect(headers.get("x-chalk-journey-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(request.credentials).toBe("same-origin");
    expect(request.body).toBe(JSON.stringify({ email: "hasan@example.com", password: "password-1" }));
  });

  it("reuses a persisted onboarding key for a safe retry and clears it after success", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-token" }))
      .mockResolvedValueOnce(Response.json({ error: { code: "upstream_unavailable", message: "Try again" } }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ tenant: { id: "tenant-1" }, access: { role: "owner" }, replayed: true }, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const { onboardTenant } = await import("./dashboard-api");
    const input = { name: "Acme studio", default_region: "us" };

    await expect(onboardTenant(input)).rejects.toMatchObject({ code: "upstream_unavailable" });
    const firstKey = new Headers((fetcher.mock.calls[1]?.[1] as RequestInit).headers).get("idempotency-key");
    await expect(onboardTenant(input)).resolves.toMatchObject({ tenant: { id: "tenant-1" } });
    const secondKey = new Headers((fetcher.mock.calls[2]?.[1] as RequestInit).headers).get("idempotency-key");
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
    expect(window.localStorage.getItem("chalk.tenant-onboarding-request")).toBeNull();
  });

  it("refreshes CSRF before the boundary cookie expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T12:00:00Z"));
    const account = { user: { id: "account-1", name: "Hasan", email: "hasan@example.com", updated_at: "2026-08-04T00:00:00Z", created_at: "2026-08-04T00:00:00Z" } };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-one" }))
      .mockResolvedValueOnce(Response.json(account))
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-two" }))
      .mockResolvedValueOnce(Response.json(account));
    vi.stubGlobal("fetch", fetcher);
    const { loginAccount } = await import("./dashboard-api");

    await loginAccount({ email: "hasan@example.com", password: "password-1" });
    vi.advanceTimersByTime(56 * 60 * 1000);
    await loginAccount({ email: "hasan@example.com", password: "password-1" });

    expect(new Headers((fetcher.mock.calls[1]?.[1] as RequestInit).headers).get("x-chalk-csrf")).toBe("csrf-one");
    expect(new Headers((fetcher.mock.calls[3]?.[1] as RequestInit).headers).get("x-chalk-csrf")).toBe("csrf-two");
  });

  it("carries Account Tenant pagination across every authorized page", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tenants: [{ tenant: { id: "tenant-1" } }], pagination: { page_size: 100, next_cursor: "cursor-2", has_more: true } }))
      .mockResolvedValueOnce(Response.json({ tenants: [{ tenant: { id: "tenant-2" } }], pagination: { page_size: 100, next_cursor: null, has_more: false } }));
    vi.stubGlobal("fetch", fetcher);
    const { listAllAccountTenants } = await import("./dashboard-api");

    await expect(listAllAccountTenants()).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/me/tenants?page_size=100", expect.anything());
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/me/tenants?cursor=cursor-2&page_size=100", expect.anything());
  });
});
