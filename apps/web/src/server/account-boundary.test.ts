import { describe, expect, it, vi } from "vitest";
import { handleAccountBoundary } from "./account-boundary";

const upstream = { CHALK_API_ORIGIN: "https://api.chalk.test" };
const secureOrigin = "https://chalk.test";

describe("account boundary", () => {
  it("issues a private, hardened CSRF cookie", async () => {
    const response = await handleAccountBoundary(new Request(`${secureOrigin}/api/auth/csrf`), upstream, vi.fn());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("set-cookie")).toMatch(/__Host-chalk_csrf=[0-9a-f]{64}/);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("set-cookie")).not.toContain("HttpOnly");

    const localResponse = await handleAccountBoundary(new Request("http://localhost/api/auth/csrf"), upstream, vi.fn());

    expect(localResponse.headers.get("set-cookie")).toMatch(/chalk_csrf_local=[0-9a-f]{64}/);
    expect(localResponse.headers.get("set-cookie")).not.toContain("__Host-chalk_csrf=");
    expect(localResponse.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("forwards only trace context and redacts private status fields", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/v1/status")) {
        expect(Object.fromEntries(headers)).toEqual({
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "chalk=web",
          "x-chalk-journey-id": "11111111-1111-4111-8111-111111111111",
        });
        return Response.json({
          schema_version: 1,
          generated_at: "2026-08-08T12:00:00Z",
          overall: "degraded",
          components: [{ id: "api", name: "API", description: "Control plane", state: "degraded", checked_at: "2026-08-08T11:59:00Z", last_changed_at: "2026-08-08T11:58:00Z", monitor_key: "private", target_url: "https://private.example", error_message: "secret" }],
        });
      }

      expect(url).toBe("https://api.chalk.test/v1/me");
      expect(headers.get("authorization")).toBe("Bearer private-token");
      expect(headers.get("traceparent")).toBeNull();
      expect(headers.get("tracestate")).toBe("chalk=web");
      return Response.json({ refresh_token: "root-secret", profile: { name: "Ada", token: "nested-secret", details: { access_token: "nested-access", safe: true } } });
    });
    const response = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/status`, {
        headers: {
          Cookie: "__Host-chalk_account=private-token",
          Authorization: "Bearer browser-token",
          "X-Chalk-Journey-ID": "11111111-1111-4111-8111-111111111111",
          Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
          Tracestate: "chalk=web",
        },
      }),
      upstream,
      fetcher,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schema_version: 1,
      generated_at: "2026-08-08T12:00:00Z",
      overall: "degraded",
      components: [{ id: "api", name: "API", description: "Control plane", state: "degraded", checked_at: "2026-08-08T11:59:00Z", last_changed_at: "2026-08-08T11:58:00Z" }],
    });

    const nestedResponse = await handleAccountBoundary(
      new Request(`${secureOrigin}/api/me`, {
        headers: { Cookie: "__Host-chalk_account=private-token", Traceparent: "not-a-traceparent", Tracestate: "chalk=web" },
      }),
      upstream,
      fetcher,
    );

    expect(nestedResponse.status).toBe(200);
    await expect(nestedResponse.json()).resolves.toEqual({ profile: { name: "Ada", details: { safe: true } } });
  });

  it("rejects a cross-origin or CSRF-invalid mutation before upstream access", async () => {
    const fetcher = vi.fn();
    const crossOrigin = await handleAccountBoundary(jsonRequest("/api/auth/login", { email: "user@example.com" }, { Origin: "https://evil.test" }), upstream, fetcher);
    const csrfMismatch = await handleAccountBoundary(jsonRequest("/api/auth/login", { email: "user@example.com" }, { Origin: secureOrigin, Cookie: "__Host-chalk_csrf=csrf-token", "X-Chalk-CSRF": "csrf-tokeX" }), upstream, fetcher);

    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ error: { code: "origin_mismatch" } });
    expect(csrfMismatch.status).toBe(403);
    await expect(csrfMismatch.json()).resolves.toMatchObject({ error: { code: "csrf_mismatch" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps credentials server-held and strips them from the login response", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.chalk.test/v1/auth/login");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      return Response.json({ session_token: "raw-account-token", expires_at: "2030-08-04T12:00:00Z", user: { id: "user-1", name: "Ada", email: "ada@example.com", secret: "remove" } });
    });
    const response = await handleAccountBoundary(jsonRequest("/api/auth/login", { email: "ada@example.com", password: "secret" }, { Origin: secureOrigin, Cookie: "__Host-chalk_csrf=csrf-token", "X-Chalk-CSRF": "csrf-token", Authorization: "Bearer browser-token" }), upstream, fetcher);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-chalk_account=raw-account-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const body = await response.text();
    expect(body).not.toContain("raw-account-token");
    expect(JSON.parse(body)).toEqual({ expires_at: "2030-08-04T12:00:00Z", user: { id: "user-1", name: "Ada", email: "ada@example.com" } });

    const localResponse = await handleAccountBoundary(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost", Cookie: "chalk_csrf_local=csrf-token", "X-Chalk-CSRF": "csrf-token" },
        body: JSON.stringify({ email: "ada@example.com", password: "secret" }),
      }),
      upstream,
      fetcher,
    );

    expect(localResponse.headers.get("set-cookie")).toContain("chalk_account_local=raw-account-token");
    expect(localResponse.headers.get("set-cookie")).not.toContain("__Host-chalk_account=");
    expect(localResponse.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("preserves the account cookie when recent authentication fails", async () => {
    const response = await handleAccountBoundary(
      jsonRequest("/api/me/recent-auth", { password: "wrong", action: "api_key.create" }, { Origin: secureOrigin, Cookie: "__Host-chalk_account=account-token; __Host-chalk_csrf=csrf-token", "X-Chalk-CSRF": "csrf-token" }),
      upstream,
      vi.fn(async () => Response.json({ error: { code: "auth.invalid_recent_auth", message: "Recent authentication failed" } }, { status: 401 })),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("clears account and CSRF cookies on logout", async () => {
    const response = await handleAccountBoundary(
      jsonRequest("/api/auth/logout", {}, { Origin: secureOrigin, Cookie: "__Host-chalk_account=account-token; __Host-chalk_csrf=csrf-token", "X-Chalk-CSRF": "csrf-token" }),
      upstream,
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    expect(cookies).toHaveLength(2);
    expect(cookies.join("\n")).toContain("__Host-chalk_account=");
    expect(cookies.join("\n")).toContain("__Host-chalk_csrf=");
    expect(cookies.join("\n")).toContain("Max-Age=0");
  });

  it("relays Feedback through its bounded account route without browser cookies", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({ schema_version: "FeedbackReportReceipt/v1", id: "22222222-2222-4222-8222-222222222222", submitted_at: "2026-08-19T12:00:00Z" }, { status: 201 }));
    const headers = {
      Origin: secureOrigin,
      Cookie: "__Host-chalk_account=account-token; __Host-chalk_csrf=csrf-token; host_cookie=never-forward",
      "X-Chalk-CSRF": "csrf-token",
      "Idempotency-Key": "feedback-request-123456",
      Traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    };
    const response = await handleAccountBoundary(jsonRequest(`/api/tenants/${tenantID}/feedback-reports`, { schema_version: "FeedbackReportRequest/v1", category: "bug", message: "x".repeat(80 * 1024), source: "dashboard", evidence: {} }, headers), upstream, fetcher);

    expect(response.status).toBe(201);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${upstream.CHALK_API_ORIGIN}/v1/tenants/${tenantID}/feedback-reports`);
    const upstreamRequestHeaders = new Headers(init?.headers);
    expect(upstreamRequestHeaders.get("authorization")).toBe("Bearer account-token");
    expect(upstreamRequestHeaders.get("cookie")).toBeNull();
    expect(upstreamRequestHeaders.get("idempotency-key")).toBe("feedback-request-123456");
    expect(upstreamRequestHeaders.get("traceparent")).toBe(headers.Traceparent);

    const oversized = await handleAccountBoundary(jsonRequest(`/api/tenants/${tenantID}/feedback-reports`, { message: "x".repeat((1 << 20) + 1) }, headers), upstream, fetcher);
    expect(oversized.status).toBe(413);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("relays only the dashboard recording and transcript routes through the tenant boundary", async () => {
    const tenantID = "11111111-1111-4111-8111-111111111111";
    const otherTenantID = "99999999-9999-4999-8999-999999999999";
    const spaceID = "22222222-2222-4222-8222-222222222222";
    const recordingID = "33333333-3333-4333-8333-333333333333";
    const transcriptID = "44444444-4444-4444-8444-444444444444";
    const cookie = "__Host-chalk_account=account-token; __Host-chalk_csrf=csrf-token";
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const routes: Array<{ method: "GET" | "POST"; path: string; upstreamPath: string; body?: string }> = [
      { method: "GET", path: `/api/tenants/${tenantID}/recordings?space_id=${spaceID}&cursor=recording-cursor&page_size=20&discard=untrusted`, upstreamPath: `/v1/tenants/${tenantID}/recordings?cursor=recording-cursor&page_size=20&space_id=${spaceID}` },
      { method: "GET", path: `/api/tenants/${tenantID}/recordings/${recordingID}`, upstreamPath: `/v1/tenants/${tenantID}/recordings/${recordingID}` },
      { method: "POST", path: `/api/tenants/${tenantID}/recordings/${recordingID}/export`, upstreamPath: `/v1/tenants/${tenantID}/recordings/${recordingID}/export`, body: "{}" },
      { method: "POST", path: `/api/tenants/${tenantID}/recordings/${recordingID}/download-url`, upstreamPath: `/v1/tenants/${tenantID}/recordings/${recordingID}/download-url`, body: JSON.stringify({ expires_in_seconds: 900 }) },
      { method: "POST", path: `/api/tenants/${tenantID}/recordings/${recordingID}/transcripts`, upstreamPath: `/v1/tenants/${tenantID}/recordings/${recordingID}/transcripts`, body: JSON.stringify({ idempotency_key: "transcript-request-key-123456", language: "en", languages: ["en"] }) },
      { method: "GET", path: `/api/tenants/${tenantID}/transcripts?recording_id=${recordingID}&cursor=transcript-cursor&page_size=2&discard=untrusted`, upstreamPath: `/v1/tenants/${tenantID}/transcripts?cursor=transcript-cursor&page_size=2&recording_id=${recordingID}` },
      { method: "GET", path: `/api/tenants/${tenantID}/transcripts/${transcriptID}/document`, upstreamPath: `/v1/tenants/${tenantID}/transcripts/${transcriptID}/document` },
    ];

    for (const route of routes) {
      const mutation = route.method === "POST";
      const response = await handleAccountBoundary(
        new Request(`${secureOrigin}${route.path}`, {
          method: route.method,
          headers: mutation ? { "Content-Type": "application/json", Cookie: cookie, Origin: secureOrigin, "X-Chalk-CSRF": "csrf-token" } : { Cookie: cookie },
          ...(mutation ? { body: route.body } : {}),
        }),
        upstream,
        fetcher,
      );
      expect(response.status).toBe(200);
    }

    expect(fetcher.mock.calls.map(([url, init]) => ({ method: init?.method, url: String(url) }))).toEqual(routes.map((route) => ({ method: route.method, url: `${upstream.CHALK_API_ORIGIN}${route.upstreamPath}` })));
    for (const [index, [, init]] of fetcher.mock.calls.entries()) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer account-token");
      expect(headers.get("cookie")).toBeNull();
      const body = init?.body;
      if (routes[index]?.body === undefined) expect(body).toBeUndefined();
      else expect(new TextDecoder().decode(body as ArrayBuffer)).toBe(routes[index].body);
    }

    const unauthenticated = await handleAccountBoundary(new Request(`${secureOrigin}/api/tenants/${tenantID}/recordings?space_id=${spaceID}`), upstream, fetcher);
    expect(unauthenticated.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(routes.length);

    const crossTenantFetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { code: "access.forbidden", message: "Tenant access is required" } }, { status: 403 }));
    const crossTenant = await handleAccountBoundary(new Request(`${secureOrigin}/api/tenants/${otherTenantID}/recordings/${recordingID}`, { headers: { Cookie: cookie } }), upstream, crossTenantFetcher);
    expect(crossTenant.status).toBe(403);
    expect(String(crossTenantFetcher.mock.calls[0]?.[0])).toBe(`${upstream.CHALK_API_ORIGIN}/v1/tenants/${otherTenantID}/recordings/${recordingID}`);

    const unsupported = await handleAccountBoundary(new Request(`${secureOrigin}/api/tenants/${tenantID}/transcripts/${transcriptID}/document`, { method: "POST", headers: { Cookie: cookie, Origin: secureOrigin, "X-Chalk-CSRF": "csrf-token" }, body: "{}" }), upstream, fetcher);
    expect(unsupported.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(routes.length);
  });
});

function jsonRequest(path: string, body: unknown, headers: HeadersInit): Request {
  return new Request(`${secureOrigin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
