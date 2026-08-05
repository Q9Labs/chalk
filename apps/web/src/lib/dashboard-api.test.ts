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

function ambiguousMutationFetcher(successBody: unknown, successStatus = 201) {
  return vi
    .fn()
    .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-token" }))
    .mockResolvedValueOnce(Response.json({ error: { code: "upstream_unavailable", message: "Try again" } }, { status: 502 }))
    .mockResolvedValueOnce(Response.json(successBody, { status: successStatus }));
}

function idempotencyKeyForCall(fetcher: ReturnType<typeof vi.fn>, call: number): string | null {
  return new Headers((fetcher.mock.calls[call]?.[1] as RequestInit).headers).get("idempotency-key");
}

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
    const fetcher = ambiguousMutationFetcher({ tenant: { id: "tenant-1" }, access: { role: "owner" }, replayed: true });
    vi.stubGlobal("fetch", fetcher);
    const { onboardTenant } = await import("./dashboard-api");
    const input = { name: "Acme studio", default_region: "us" };

    await expect(onboardTenant(input)).rejects.toMatchObject({ code: "upstream_unavailable" });
    const firstKey = idempotencyKeyForCall(fetcher, 1);
    await expect(onboardTenant(input)).resolves.toMatchObject({ tenant: { id: "tenant-1" } });
    const secondKey = idempotencyKeyForCall(fetcher, 2);
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

  it("keeps journey and trace correlation across a CSRF recovery retry", async () => {
    const account = { user: { id: "account-1", name: "Hasan", email: "hasan@example.com", updated_at: "2026-08-04T00:00:00Z", created_at: "2026-08-04T00:00:00Z" } };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-stale" }))
      .mockResolvedValueOnce(Response.json({ error: { code: "csrf_mismatch", message: "Refresh CSRF" } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-fresh" }))
      .mockResolvedValueOnce(Response.json(account));
    vi.stubGlobal("fetch", fetcher);
    const { loginAccount } = await import("./dashboard-api");

    await expect(loginAccount({ email: "hasan@example.com", password: "password-1" })).resolves.toMatchObject({ id: "account-1" });

    const firstHeaders = new Headers((fetcher.mock.calls[1]?.[1] as RequestInit).headers);
    const retryHeaders = new Headers((fetcher.mock.calls[3]?.[1] as RequestInit).headers);
    expect(retryHeaders.get("x-chalk-csrf")).toBe("csrf-fresh");
    expect(retryHeaders.get("x-chalk-journey-id")).toBe(firstHeaders.get("x-chalk-journey-id"));
    expect(retryHeaders.get("traceparent")).toBe(firstHeaders.get("traceparent"));
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

  it("keeps tenant-wide Episode history bounded and resumes each Space stream from a composite cursor", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const spaceOne = { id: "space-one", name: "One" };
    const spaceTwo = { id: "space-two", name: "Two" };
    const episode = (id: string, spaceID: string, started_at: string) => ({ id, tenant_id: tenantID, space_id: spaceID, status: "ended", started_at });
    const firstSpacePage = { spaces: [spaceOne, spaceTwo], pagination: { page_size: 24, next_cursor: null, has_more: false } };
    const spaceOneEpisodes = { episodes: [episode("episode-one-new", spaceOne.id, "2026-08-04T10:00:00Z"), episode("episode-one-old", spaceOne.id, "2026-08-04T08:00:00Z")], pagination: { page_size: 2, next_cursor: "space-one-next", has_more: true } };
    const spaceTwoEpisodes = { episodes: [episode("episode-two-new", spaceTwo.id, "2026-08-04T11:00:00Z"), episode("episode-two-old", spaceTwo.id, "2026-08-04T07:00:00Z")], pagination: { page_size: 2, next_cursor: null, has_more: false } };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(firstSpacePage))
      .mockResolvedValueOnce(Response.json(spaceOneEpisodes))
      .mockResolvedValueOnce(Response.json(spaceTwoEpisodes))
      .mockResolvedValueOnce(Response.json(spaceOneEpisodes))
      .mockResolvedValueOnce(Response.json(spaceTwoEpisodes));
    vi.stubGlobal("fetch", fetcher);
    const { listEpisodes } = await import("./dashboard-api");

    const first = await listEpisodes({ tenantID, pageSize: 2 });
    expect(first.episodes.map((item) => item.id)).toEqual(["episode-two-new", "episode-one-new"]);
    expect(first.pagination).toMatchObject({ page_size: 2, has_more: true });
    expect(first.pagination.next_cursor).toEqual(expect.any(String));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenNthCalledWith(1, `/api/tenants/${tenantID}/spaces?page_size=24`, expect.anything());
    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/tenants/${tenantID}/spaces/${spaceOne.id}/episodes?page_size=2`, expect.anything());
    expect(fetcher).toHaveBeenNthCalledWith(3, `/api/tenants/${tenantID}/spaces/${spaceTwo.id}/episodes?page_size=2`, expect.anything());

    const second = await listEpisodes({ tenantID, pageSize: 2, cursor: first.pagination.next_cursor ?? undefined });
    expect(second.episodes.map((item) => item.id)).toEqual(["episode-one-old", "episode-two-old"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher).toHaveBeenNthCalledWith(4, `/api/tenants/${tenantID}/spaces/${spaceOne.id}/episodes?page_size=2`, expect.anything());
    expect(fetcher).toHaveBeenNthCalledWith(5, `/api/tenants/${tenantID}/spaces/${spaceTwo.id}/episodes?page_size=2`, expect.anything());
  });

  it("discovers every bounded Space page before ordering tenant-wide Episode history", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const spaces = Array.from({ length: 25 }, (_, index) => ({ id: `space-${index}`, name: `Space ${index}` }));
    const firstSpacePage = { spaces: spaces.slice(0, 24), pagination: { page_size: 24, next_cursor: "spaces-next", has_more: true } };
    const lastSpacePage = { spaces: spaces.slice(24), pagination: { page_size: 24, next_cursor: null, has_more: false } };
    const fetcher = vi.fn((path: string) => {
      if (path === `/api/tenants/${tenantID}/spaces?page_size=24`) return Promise.resolve(Response.json(firstSpacePage));
      if (path === `/api/tenants/${tenantID}/spaces?cursor=spaces-next&page_size=24`) return Promise.resolve(Response.json(lastSpacePage));
      const match = path.match(new RegExp(`/api/tenants/${tenantID}/spaces/([^/]+)/episodes\\?page_size=1$`));
      if (!match) return Promise.reject(new Error(`Unexpected request: ${path}`));
      const spaceID = decodeURIComponent(match[1]!);
      const index = spaces.findIndex((space) => space.id === spaceID);
      return Promise.resolve(
        Response.json({
          episodes: [{ id: `episode-${spaceID}`, tenant_id: tenantID, space_id: spaceID, status: "ended", started_at: new Date(Date.UTC(2026, 7, 4, index)).toISOString() }],
          pagination: { page_size: 1, next_cursor: null, has_more: false },
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const { listEpisodes } = await import("./dashboard-api");

    const page = await listEpisodes({ tenantID, pageSize: 1 });

    expect(page.episodes.map((item) => item.id)).toEqual(["episode-space-24"]);
    expect(page.pagination).toMatchObject({ page_size: 1, has_more: true });
    expect(fetcher).toHaveBeenCalledTimes(27);
  });

  it("rejects an oversized Tenant history instead of returning a misordered partial merge", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    let pageNumber = 0;
    const fetcher = vi.fn((path: string) => {
      expect(path).toContain(`/api/tenants/${tenantID}/spaces`);
      pageNumber += 1;
      const hasMore = pageNumber < 6;
      return Promise.resolve(
        Response.json({
          spaces: Array.from({ length: 24 }, (_, index) => ({ id: `space-${pageNumber}-${index}`, name: `Space ${pageNumber}-${index}` })),
          pagination: { page_size: 24, next_cursor: hasMore ? `cursor-${pageNumber}` : null, has_more: hasMore },
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const { listEpisodes } = await import("./dashboard-api");

    await expect(listEpisodes({ tenantID, pageSize: 25 })).rejects.toMatchObject({ code: "episode_history_too_large" });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("reuses an Episode creation key after an ambiguous failure", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const spaceID = "22222222-2222-4222-8222-222222222222";
    const episode = { id: "33333333-3333-4333-8333-333333333333", tenant_id: tenantID, space_id: spaceID, status: "active" };
    const fetcher = ambiguousMutationFetcher(episode);
    vi.stubGlobal("fetch", fetcher);
    const { createEpisode } = await import("./dashboard-api");

    await expect(createEpisode({ tenantID, spaceID })).rejects.toMatchObject({ code: "upstream_unavailable" });
    const firstKey = idempotencyKeyForCall(fetcher, 1);
    await expect(createEpisode({ tenantID, spaceID })).resolves.toMatchObject({ id: episode.id });
    const retryKey = idempotencyKeyForCall(fetcher, 2);

    expect(retryKey).toBe(firstKey);
    expect(window.localStorage.getItem("chalk.dashboard-request.episode-create")).toBeNull();
  });

  it("retains an Episode-end key while the operation is ending and clears it after completion", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const spaceID = "22222222-2222-4222-8222-222222222222";
    const episodeID = "33333333-3333-4333-8333-333333333333";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-token" }))
      .mockResolvedValueOnce(Response.json({ status: "ending" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: "ended" }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    const { endEpisode } = await import("./dashboard-api");
    const input = { tenantID, spaceID, episodeID };

    await endEpisode(input);
    const firstKey = idempotencyKeyForCall(fetcher, 1);
    expect(window.localStorage.getItem("chalk.dashboard-request.episode-end")).toContain(firstKey);

    await endEpisode(input);
    expect(idempotencyKeyForCall(fetcher, 2)).toBe(firstKey);
    expect(window.localStorage.getItem("chalk.dashboard-request.episode-end")).toBeNull();
  });

  it("reuses a Space creation key after an ambiguous failure", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const created = { id: "22222222-2222-4222-8222-222222222222", tenant_id: tenantID, name: "Product studio", slug: "product-studio" };
    const fetcher = ambiguousMutationFetcher(created);
    vi.stubGlobal("fetch", fetcher);
    const { createSpace } = await import("./dashboard-api");
    const input = { tenantID, name: "Product studio", slug: "product-studio" };

    await expect(createSpace(input)).rejects.toMatchObject({ code: "upstream_unavailable" });
    const firstKey = idempotencyKeyForCall(fetcher, 1);
    await expect(createSpace(input)).resolves.toMatchObject({ id: created.id });
    const retryKey = idempotencyKeyForCall(fetcher, 2);

    expect(retryKey).toBe(firstKey);
    expect(window.localStorage.getItem("chalk.dashboard-request.space-create")).toBeNull();
  });

  it("carries recent-auth proof to API-key mutations without putting it in the body", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const keyID = "22222222-2222-4222-8222-222222222222";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-token" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const { revokeAPIKey } = await import("./dashboard-api");

    await revokeAPIKey(tenantID, keyID, { recentAuth: "recent-proof" });

    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/tenants/${tenantID}/api-keys/${keyID}`, expect.objectContaining({ method: "DELETE" }));
    const request = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("x-chalk-recent-auth")).toBe("recent-proof");
    expect(request.body).toBeUndefined();
  });

  it("starts and completes Google recent auth with only the allowlisted query fields", async () => {
    const resourceID = "22222222-2222-4222-8222-222222222222";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ authorization_url: "https://accounts.google.test/oauth", state: "opaque-state" }))
      .mockResolvedValueOnce(Response.json({ proof: "opaque-proof", expires_at: "2030-01-01T00:00:00Z" }));
    vi.stubGlobal("fetch", fetcher);
    const { completeRecentAuthGoogle, startRecentAuthGoogle } = await import("./dashboard-api");

    await expect(startRecentAuthGoogle({ action: "api_key.create", resource_id: resourceID })).resolves.toEqual({ authorization_url: "https://accounts.google.test/oauth", state: "opaque-state" });
    await expect(completeRecentAuthGoogle({ state: "opaque-state", code: "provider-code" })).resolves.toEqual({ proof: "opaque-proof", expires_at: "2030-01-01T00:00:00Z" });
    expect(fetcher).toHaveBeenNthCalledWith(1, `/api/me/recent-auth/google/start?action=api_key.create&resource_id=${resourceID}`, expect.objectContaining({ credentials: "same-origin" }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/me/recent-auth/google/callback?state=opaque-state&code=provider-code", expect.objectContaining({ credentials: "same-origin" }));
    expect(new Headers((fetcher.mock.calls[1]?.[1] as RequestInit | undefined)?.headers).get("x-chalk-csrf")).toBeNull();
  });
});
