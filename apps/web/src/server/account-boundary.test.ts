import { describe, expect, it, vi } from "vitest";
import { handleAccountBoundary } from "./account-boundary";

const upstream = { CHALK_API_ORIGIN: "https://api.chalk.test" };
const secureOrigin = "https://chalk.test";
const upstreamCredentialField = "session_token";

function recentAuthFailureFetcher() {
  return vi.fn(async () => Response.json({ error: { code: "auth.invalid_recent_auth", message: "Recent authentication failed" } }, { status: 401 }));
}

function expectAccountCookiePreserved(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
}

describe("account boundary", () => {
  it("issues a hardened CSRF cookie and private response", async () => {
    const response = await handleAccountBoundary(new Request(`${secureOrigin}/api/auth/csrf`), upstream, vi.fn());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("set-cookie")).toContain("__Host-chalk_csrf=");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("set-cookie")).not.toContain("HttpOnly");
    await expect(response.json()).resolves.toMatchObject({ csrf_token: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("proxies anonymous public status without cookies or private monitor fields", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.chalk.test/v1/status");
      const headers = new Headers(init?.headers);
      expect(Object.fromEntries(headers)).toEqual({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "chalk=web",
        "x-chalk-journey-id": "11111111-1111-4111-8111-111111111111",
      });
      return Response.json({
        schema_version: 1,
        generated_at: "2026-08-08T12:00:00Z",
        overall: "degraded",
        components: [
          {
            id: "api",
            name: "API",
            description: "Chalk control plane API",
            state: "degraded",
            checked_at: "2026-08-08T11:59:00Z",
            last_changed_at: "2026-08-08T11:58:00Z",
            monitor_key: "private.monitor",
            target_url: "https://private.example",
            error_message: "private failure details",
          },
        ],
      });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/status`, {
        headers: {
          Cookie: "__Host-chalk_account=private-token",
          Authorization: "Bearer private-token",
          "x-chalk-journey-id": "11111111-1111-4111-8111-111111111111",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "chalk=web",
        },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Origin");
    await expect(response.json()).resolves.toEqual({
      schema_version: 1,
      generated_at: "2026-08-08T12:00:00Z",
      overall: "degraded",
      components: [
        {
          id: "api",
          name: "API",
          description: "Chalk control plane API",
          state: "degraded",
          checked_at: "2026-08-08T11:59:00Z",
          last_changed_at: "2026-08-08T11:58:00Z",
        },
      ],
    });
  });

  it("rejects mutations before upstream access when origin or CSRF validation fails", async () => {
    const fetcher = vi.fn();
    const response = await handleAccountBoundary(jsonRequest("/api/auth/login", { email: "hasan@example.com", password: "secret" }, { Origin: "https://evil.test" }), upstream, fetcher);

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: { code: "origin_mismatch", message: "A same-origin request is required" } });
  });

  it("keeps the upstream credential in an HttpOnly cookie and strips browser credentials", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.chalk.test/v1/auth/login");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-chalk-journey-id")).toBe("11111111-1111-4111-8111-111111111111");
      expect(headers.get("traceparent")).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
      return Response.json(
        {
          [upstreamCredentialField]: "raw-account-token",
          expires_at: "2030-08-04T12:00:00Z",
          user: { id: "user-1", name: "Hasan", email: "hasan@example.com", extra: "removed" },
        },
        { headers: { "Cache-Control": "public, max-age=3600", "Set-Cookie": "chalk_account=raw-account-token" } },
      );
    });
    const response = await handleAccountBoundary(
      jsonRequest(
        "/api/auth/login",
        { email: "hasan@example.com", password: "secret" },
        {
          Origin: secureOrigin,
          Cookie: "__Host-chalk_csrf=csrf-token; unrelated=browser-cookie",
          "X-Chalk-CSRF": "csrf-token",
          "X-Chalk-Journey-ID": "11111111-1111-4111-8111-111111111111",
          Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          Authorization: "Bearer browser-controlled-token",
        },
      ),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("set-cookie")).toContain("__Host-chalk_account=raw-account-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const body = await response.text();
    expect(body).not.toContain("raw-account-token");
    expect(JSON.parse(body)).toEqual({ expires_at: "2030-08-04T12:00:00Z", user: { id: "user-1", name: "Hasan", email: "hasan@example.com" } });
  });

  it("forwards only the boundary account cookie and idempotency context", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.chalk.test/v1/me/tenants");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer server-held-account-token");
      expect(headers.get("idempotency-key")).toBe("tenant-onboard-0001");
      return Response.json({ tenant: { id: "tenant-1", token: "remove-me" }, access: { role: "owner" }, replayed: false });
    });
    const response = await handleAccountBoundary(
      jsonRequest(
        "/api/me/tenants?browser_controlled=discarded",
        { name: "Acme studio" },
        {
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
          "Idempotency-Key": "tenant-onboard-0001",
        },
      ),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenant: { id: "tenant-1" }, access: { role: "owner" }, replayed: false });
  });

  it("allowlists Tenant pagination and drops browser-controlled query fields", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.chalk.test/v1/me/tenants?cursor=next-page&page_size=100");
      return Response.json({ tenants: [], pagination: { page_size: 100, next_cursor: null, has_more: false } });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/me/tenants?cursor=next-page&page_size=100&admin=true`, {
        headers: { Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("allowlists nested Space and Episode routes without accepting arbitrary upstream paths", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const spaceID = "22222222-2222-4222-8222-222222222222";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://api.chalk.test/v1/tenants/${tenantID}/spaces/${spaceID}/episodes?page_size=25`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-held-account-token");
      return Response.json({ episodes: [], pagination: { page_size: 25, next_cursor: null, has_more: false } });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/tenants/${tenantID}/spaces/${spaceID}/episodes?page_size=25&admin=true`, {
        headers: { Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();

    const rejected = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/tenants/${tenantID}/spaces/not-a-uuid/episodes`, {
        headers: { Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      fetcher,
    );
    expect(rejected.status).toBe(404);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("forwards a slug-based Dashboard Space grant without stripping its opaque credentials", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const grant = {
      subject: { tenant_id: tenantID, space_id: "space", episode_id: "episode", participant_id: "participant", participant_generation: 1 },
      sync: { token: "opaque-sync", expires_at: "2030-01-01T00:00:00Z" },
      media: { token: "opaque-media", expires_at: "2030-01-01T00:00:00Z", provider: "cloudflare_sfu", client_payload: {} },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://api.chalk.test/v1/tenants/${tenantID}/spaces/by-slug/design-lab/participants/self`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-held-account-token");
      return Response.json(grant, { status: 201 });
    });

    const response = await handleAccountBoundary(
      jsonRequest(
        `/api/tenants/${tenantID}/spaces/by-slug/design-lab/participants/self`,
        { display_name: "Ada" },
        {
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
        },
      ),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(grant);
  });

  it("routes PostgreSQL UUID-shaped tenant, Space, Episode, and API-key IDs", async () => {
    const tenantID = "00000000-0000-0000-c000-000000000001";
    const spaceID = "00000000-0000-0000-c000-000000000002";
    const episodeID = "00000000-0000-0000-c000-000000000003";
    const apiKeyID = "00000000-0000-0000-c000-000000000004";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        expect(String(input)).toBe(`https://api.chalk.test/v1/tenants/${tenantID}/api-keys/${apiKeyID}`);
        return new Response(null, { status: 204 });
      }
      expect(String(input)).toBe(`https://api.chalk.test/v1/tenants/${tenantID}/spaces/${spaceID}/episodes/${episodeID}`);
      return Response.json({ episode: { id: episodeID } });
    });

    const episodeResponse = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/tenants/${tenantID}/spaces/${spaceID}/episodes/${episodeID}`, {
        headers: { Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      fetcher,
    );
    expect(episodeResponse.status).toBe(200);

    const apiKeyResponse = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/tenants/${tenantID}/api-keys/${apiKeyID}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
        },
      }),
      upstream,
      fetcher,
    );
    expect(apiKeyResponse.status).toBe(204);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("requires same-origin CSRF proof for API-key revocation", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const apiKeyID = "33333333-3333-4333-8333-333333333333";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://api.chalk.test/v1/tenants/${tenantID}/api-keys/${apiKeyID}`);
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/tenants/${tenantID}/api-keys/${apiKeyID}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
        },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("forwards a bounded recent-auth proof only on an allowlisted API-key mutation", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-chalk-recent-auth")).toBe("recent-proof");
      return Response.json({ api_key: { id: "key-1" }, secret: "chalk_secret_once" }, { status: 201 });
    });
    const response = await handleAccountBoundary(
      jsonRequest(
        `/api/tenants/${tenantID}/api-keys`,
        { name: "CI", scopes: ["spaces:read"], expires_at: "2030-01-01T00:00:00Z" },
        {
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
          "X-Chalk-Recent-Auth": "recent-proof",
        },
      ),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ secret: "chalk_secret_once" });
  });

  it("does not clear Account authentication when recent password verification fails", async () => {
    const response = await handleAccountBoundary(
      jsonRequest(
        "/api/me/recent-auth",
        { password: "wrong", action: "api_key.create", resource_id: "11111111-1111-4111-8111-111111111111" },
        {
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
        },
      ),
      upstream,
      recentAuthFailureFetcher(),
    );

    expectAccountCookiePreserved(response);
  });

  it("forwards only the Google recent-auth start query contract", async () => {
    const resourceID = "22222222-2222-4222-8222-222222222222";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://api.chalk.test/v1/me/recent-auth/google/start?action=api_key.create&resource_id=${resourceID}`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-held-account-token");
      return Response.json({ authorization_url: "https://accounts.google.test/oauth?state=opaque", state: "opaque-state" });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/me/recent-auth/google/start?action=api_key.create&resource_id=${resourceID}&discarded=1`, {
        headers: { Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ authorization_url: "https://accounts.google.test/oauth?state=opaque", state: "opaque-state" });
  });

  it("bridges the browser Google callback with a nonce-bound same-origin message", async () => {
    const proof = "opaque-provider-proof";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.chalk.test/v1/me/recent-auth/google/callback?state=opaque-state&code=provider-code");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-held-account-token");
      return Response.json({ proof, expires_at: "2030-08-04T12:00:00Z" });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/me/recent-auth/google/callback?state=opaque-state&code=provider-code&discarded=1`, {
        headers: { Accept: "text/html", Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const csp = response.headers.get("content-security-policy");
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]+/);
    const body = await response.text();
    expect(body).toContain("chalk.recent-auth.google.complete");
    expect(body).toContain(JSON.stringify(proof));
    expect(body).toContain(JSON.stringify(secureOrigin));
    expect(body).not.toContain("discarded");
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining(proof));
    info.mockRestore();
  });

  it("keeps JSON callback responses available to same-origin API clients", async () => {
    const fetcher = vi.fn(async () => Response.json({ proof: "opaque-provider-proof", expires_at: "2030-08-04T12:00:00Z" }));
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/me/recent-auth/google/callback?state=opaque-state&code=provider-code`, {
        headers: { Accept: "application/json", Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      fetcher,
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ proof: "opaque-provider-proof", expires_at: "2030-08-04T12:00:00Z" });
  });

  it("preserves the Account cookie when the browser callback reports a recent-auth failure", async () => {
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/me/recent-auth/google/callback?state=opaque-state&code=provider-code`, {
        headers: { Accept: "text/html", Cookie: "__Host-chalk_account=server-held-account-token" },
      }),
      upstream,
      recentAuthFailureFetcher(),
    );

    expectAccountCookiePreserved(response);
    expect(await response.text()).toContain("auth.invalid_recent_auth");
  });

  it("preserves the Account cookie when an API-key mutation rejects recent authentication", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const apiKeyID = "22222222-2222-4222-8222-222222222222";
    const routes = [
      { method: "POST", path: `/api/tenants/${tenantID}/api-keys`, body: { name: "CI", scopes: ["spaces:read"], expires_at: "2030-01-01T00:00:00Z" } },
      { method: "POST", path: `/api/tenants/${tenantID}/api-keys/${apiKeyID}/rotate`, body: {} },
      { method: "DELETE", path: `/api/tenants/${tenantID}/api-keys/${apiKeyID}`, body: {} },
    ] as const;

    for (const route of routes) {
      const fetcher = vi.fn(async () => Response.json({ error: { code: "auth.invalid_recent_auth", message: "Recent authentication failed" } }, { status: 401 }));
      const response = await handleAccountBoundary(
        new Request(`${secureOrigin}${route.path}`, {
          method: route.method,
          headers: {
            "Content-Type": "application/json",
            Origin: secureOrigin,
            Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
            "X-Chalk-CSRF": "csrf-token",
            "X-Chalk-Recent-Auth": "expired-proof",
          },
          body: JSON.stringify(route.body),
        }),
        upstream,
        fetcher,
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(fetcher).toHaveBeenCalledOnce();
    }

    const expiredLogin = await handleAccountBoundary(
      jsonRequest(
        `/api/tenants/${tenantID}/api-keys`,
        { name: "CI", scopes: ["spaces:read"], expires_at: "2030-01-01T00:00:00Z" },
        {
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=expired-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
        },
      ),
      upstream,
      vi.fn(async () => Response.json({ error: { code: "access.unauthenticated", message: "Authentication required" } }, { status: 401 })),
    );

    expect(expiredLogin.headers.get("set-cookie")).toContain("__Host-chalk_account=");
  });

  it("clears both account and CSRF cookies on logout", async () => {
    const response = await handleAccountBoundary(
      jsonRequest(
        "/api/auth/logout",
        {},
        {
          Origin: secureOrigin,
          Cookie: "__Host-chalk_account=server-held-account-token; __Host-chalk_csrf=csrf-token",
          "X-Chalk-CSRF": "csrf-token",
        },
      ),
      upstream,
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    expect(cookies).toHaveLength(2);
    expect(cookies.join("\n")).toContain("__Host-chalk_account=");
    expect(cookies.join("\n")).toContain("__Host-chalk_csrf=");
    expect(cookies.join("\n")).toContain("Max-Age=0");
  });

  it("rejects an unsafe OAuth return path", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://accounts.google.test/oauth" } }));
    const response = await handleAccountBoundary(new Request(`${secureOrigin}/api/auth/google/start?return_to=//evil.test`), upstream, fetcher);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://accounts.google.test/oauth");
    expect(response.headers.get("set-cookie")).toContain(encodeURIComponent("/home"));
  });

  it("completes Google OAuth through the boundary and restores the safe return path", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.chalk.test/v1/auth/google/callback?state=state-1&code=code-1");
      return Response.json({
        [upstreamCredentialField]: "raw-google-token",
        expires_at: "2030-08-04T12:00:00Z",
        user: { id: "account-1", name: "Hasan", email: "hasan@example.com" },
      });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/auth/google/callback?state=state-1&code=code-1&return_to=https://evil.test`, {
        headers: { Cookie: "__Host-chalk_oauth_return=%2Fspaces" },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://chalk.test/spaces");
    expect(response.headers.get("set-cookie")).toContain("__Host-chalk_account=raw-google-token");
  });

  it("includes the journey identifier in its structured request log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await handleAccountBoundary(
      new Request(`${secureOrigin}/api/healthz`, { headers: { "X-Chalk-Journey-ID": "11111111-1111-4111-8111-111111111111" } }),
      upstream,
      vi.fn(async () => Response.json({ status: "ok" })),
    );

    expect(info).toHaveBeenCalledWith(expect.stringContaining('"journey_id":"11111111-1111-4111-8111-111111111111"'));
    info.mockRestore();
  });

  it("logs bounded route templates instead of resource identifiers", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const tenantID = "11111111-1111-4111-8111-111111111111";
    await handleAccountBoundary(
      new Request(`${secureOrigin}/api/tenants/${tenantID}/spaces`, { headers: { Cookie: "__Host-chalk_account=server-held-account-token" } }),
      upstream,
      vi.fn(async () => Response.json({ spaces: [], pagination: { page_size: 50, next_cursor: null, has_more: false } })),
    );

    expect(info).toHaveBeenCalledWith(expect.stringContaining('"route":"/api/tenants/{id}/spaces"'));
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining(tenantID));
    info.mockRestore();
  });

  it("refuses a non-allowlisted upstream origin", async () => {
    const response = await handleAccountBoundary(new Request(`${secureOrigin}/api/healthz`), { CHALK_API_ORIGIN: "http://metadata.internal" }, vi.fn());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ dependencies: { account_api: "unavailable" } });
  });
});

function jsonRequest(path: string, body: unknown, headers: HeadersInit): Request {
  return new Request(`${secureOrigin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
