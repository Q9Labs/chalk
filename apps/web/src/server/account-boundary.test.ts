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
});

function jsonRequest(path: string, body: unknown, headers: HeadersInit): Request {
  return new Request(`${secureOrigin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
