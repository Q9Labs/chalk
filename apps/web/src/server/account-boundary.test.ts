import { describe, expect, it, vi } from "vitest";
import { handleAccountBoundary } from "./account-boundary";

const upstream = { CHALK_API_ORIGIN: "https://api.chalk.test" };
const secureOrigin = "https://chalk.test";
const upstreamCredentialField = "session_token";

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

  it("refuses a non-allowlisted upstream origin", async () => {
    const response = await handleAccountBoundary(new Request(`${secureOrigin}/api/healthz`), { CHALK_API_ORIGIN: "http://metadata.internal" }, vi.fn());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ dependencies: { account_api: "unavailable" } });
  });
});

function jsonRequest(path: string, body: unknown, headers: HeadersInit): Request {
  return new Request(`${secureOrigin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
