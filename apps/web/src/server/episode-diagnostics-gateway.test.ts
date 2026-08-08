import { describe, expect, it, vi } from "vitest";
import { handleEpisodeDiagnosticsGateway, type EpisodeDiagnosticsGatewayEnv } from "./episode-diagnostics-gateway";

const origin = "https://chalk.test";
const env: EpisodeDiagnosticsGatewayEnv = {
  CHALK_API_ORIGIN: "https://api.chalk.test",
  CHALK_EPISODE_DIAGNOSTICS_SIGNED_DOWNLOAD_HOSTS: "downloads.chalk.test",
  CHALK_EPISODE_DIAGNOSTICS_GATEWAY: "verified",
  CHALK_EPISODE_DIAGNOSTICS: "hosted",
  CHALK_ENVIRONMENT: "staging",
};

const productionEnv: EpisodeDiagnosticsGatewayEnv = {
  ...env,
  CHALK_ENVIRONMENT: "production",
  CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN: "true",
};

function mockGatewayFetch(...responses: Response[]) {
  const fetcher = vi.fn();
  fetcher.mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }));
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
}

function expectSafeDownloadResponse(response: Response, contentDisposition: string) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toBe(contentDisposition);
  expect(response.headers.get("authorization")).toBeNull();
}

describe("Episode Diagnostics gateway", () => {
  it("accepts a fully configured production hosted gateway with the explicit opt-in", async () => {
    const fetcher = mockGatewayFetch(Response.json({ diagnostic_id: "chalkdiag:v1:production:diag01" }));
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Aproduction%3Adiag01`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }), productionEnv, fetcher);

    expect(response.status).toBe(200);
  });

  it("rejects production hosted mode when the opt-in is absent", async () => {
    const fetcher = vi.fn();
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Aproduction%3Adiag01`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }),
      { ...productionEnv, CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN: undefined },
      fetcher,
    );

    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "gateway.misconfigured" });
  });

  it("keeps signed download host validation enabled in production", async () => {
    const fetcher = mockGatewayFetch(new Response(null, { status: 302, headers: { Location: "https://downloads.chalk.test/diagnostics/job-1" } }));
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Aproduction%3Adiag01/export-jobs/job-1/download`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }),
      { ...productionEnv, CHALK_EPISODE_DIAGNOSTICS_SIGNED_DOWNLOAD_HOSTS: undefined },
      fetcher,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "download.misconfigured" });
  });

  it("rejects a cross-origin request before account or diagnostic upstream calls", async () => {
    const fetcher = vi.fn();
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01`, {
        headers: { Origin: "https://evil.test", Cookie: "__Host-chalk_account=account-token" },
      }),
      env,
      fetcher,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ code: "origin.mismatch", message: "A same-origin request is required" });
  });

  it("requires the authenticated dashboard cookie", async () => {
    const fetcher = vi.fn();
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01`), env, fetcher);

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks the account server, forwards only the account bearer, and preserves trace context", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(new Response("id: 4\nevent: close\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream", authorization: "Bearer upstream-secret" } }));
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/stream?after=3&discarded=https%3A%2F%2Fevil.test`, {
        headers: {
          Cookie: "__Host-chalk_account=account-token; other=discarded",
          Origin: origin,
          "X-Chalk-Journey-ID": "11111111-1111-4111-8111-111111111111",
          Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          Tracestate: "vendor=value",
          "Last-Event-ID": "3",
          Accept: "text/event-stream",
        },
      }),
      env,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("x-chalk-journey-id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const accountHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(accountHeaders.get("authorization")).toBe("Bearer account-token");
    const [diagnosticURL, diagnosticInit] = fetcher.mock.calls[1] as [URL, RequestInit];
    expect(diagnosticURL.toString()).toBe("https://api.chalk.test/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/stream?after=3");
    const diagnosticHeaders = new Headers(diagnosticInit.headers);
    expect(diagnosticHeaders.get("authorization")).toBe("Bearer account-token");
    expect(diagnosticHeaders.get("cookie")).toBeNull();
    expect(diagnosticHeaders.get("traceparent")).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(diagnosticHeaders.get("last-event-id")).toBe("3");
  });

  it("keeps cross-account diagnostics denials bound to each account bearer", async () => {
    const diagnosticCalls: Array<{ authorization: string | null; reference: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestURL = new URL(String(input));
      if (requestURL.pathname === "/v1/me") return Response.json({ user: { id: "account" } });

      diagnosticCalls.push({ authorization: new Headers(init?.headers).get("authorization"), reference: requestURL.pathname.split("/").at(-1) ?? "" });
      return Response.json({ code: "tenant_access_denied", message: "The diagnostic is outside the account tenant scope" }, { status: 403 });
    });

    const requestFor = (accountToken: string, reference: string) =>
      new Request(`${origin}/_internal/episode-diagnostics/${reference}`, {
        headers: { Cookie: `__Host-chalk_account=${accountToken}`, Origin: origin },
      });

    const first = await handleEpisodeDiagnosticsGateway(requestFor("account-a", "chalkdiag%3Av1%3Astaging%3Adiag-a"), env, fetcher);
    const second = await handleEpisodeDiagnosticsGateway(requestFor("account-b", "chalkdiag%3Av1%3Astaging%3Adiag-b"), env, fetcher);

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(diagnosticCalls).toEqual([
      { authorization: "Bearer account-a", reference: "chalkdiag%3Av1%3Astaging%3Adiag-a" },
      { authorization: "Bearer account-b", reference: "chalkdiag%3Av1%3Astaging%3Adiag-b" },
    ]);
    expect(diagnosticCalls.every(({ authorization }) => authorization !== "Bearer operator-test-token")).toBe(true);
  });

  it("does not fall back to a global operator token on hosted requests", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(Response.json({ code: "tenant_access_denied", message: "Forbidden" }, { status: 403 }));
    const hostedEnvWithLegacyToken = {
      ...env,
      CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN: "legacy-global-token",
    } as EpisodeDiagnosticsGatewayEnv;

    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01`, {
        headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin },
      }),
      hostedEnvWithLegacyToken,
      fetcher,
    );

    expect(response.status).toBe(403);
    const diagnosticHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(diagnosticHeaders.get("authorization")).toBe("Bearer account-token");
    expect(diagnosticHeaders.get("authorization")).not.toBe("Bearer legacy-global-token");
  });

  it("requires the account CSRF cookie and header for export mutations", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: "ExportJob/v1", jobId: "job-1", reference: "chalkdiag:v1:staging:diag01", state: "queued", createdAt: "2026-08-04T10:00:00.000Z", leaseEndsAt: "2026-08-04T10:05:00.000Z", cursorFrom: 0, cursorTo: 4 }));
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/export-jobs`, {
        method: "POST",
        headers: {
          Cookie: "__Host-chalk_account=account-token; __Host-chalk_csrf=csrf-token",
          Origin: origin,
          "X-Chalk-CSRF": "csrf-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: "ExportJobRequest/v1", cursorTo: 4 }),
      }),
      env,
      fetcher,
    );

    expect(response.status).toBe(200);
    const diagnosticHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(diagnosticHeaders.get("x-chalk-csrf")).toBeNull();
    expect(diagnosticHeaders.get("cookie")).toBeNull();
  });

  it("rejects an export mutation without a matching account CSRF proof", async () => {
    const fetcher = vi.fn();
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/export-jobs`, {
        method: "POST",
        headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: "ExportJobRequest/v1", cursorTo: 4 }),
      }),
      env,
      fetcher,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "csrf.mismatch", message: "CSRF validation failed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("follows an allowlisted signed download redirect without forwarding gateway credentials", async () => {
    const fetcher = mockGatewayFetch(
      new Response(null, { status: 302, headers: { Location: "https://downloads.chalk.test/diagnostics/job-1?X-Amz-Signature=secret" } }),
      new Response("redacted bundle", { status: 200, headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="episode-diagnostic-job-1.gz"', "content-length": "15", authorization: "Bearer should-not-return" } }),
    );
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/export-jobs/job-1/download`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }), env, fetcher);

    expectSafeDownloadResponse(response, 'attachment; filename="episode-diagnostic-job-1.gz"');
    expect(await response.text()).toBe("redacted bundle");
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [signedURL, signedInit] = fetcher.mock.calls[2] as [URL, RequestInit];
    expect(signedURL.toString()).toContain("https://downloads.chalk.test/diagnostics/job-1");
    expect(new Headers(signedInit.headers).get("authorization")).toBeNull();
    expect(signedInit.credentials).toBe("omit");
  });

  it("rejects a hostile signed download redirect", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://evil.test/private-bundle" } }));
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/export-jobs/job-1/download`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }), env, fetcher);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "download.redirect_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves safe inline artifact metadata while stripping secret response headers", async () => {
    const fetcher = mockGatewayFetch(
      new Response("inline bundle", {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="episode-diagnostic-job-1.zip"', "x-chalk-diagnostic-checksum": "A".repeat(64), authorization: "Bearer secret", "set-cookie": "opaque=secret" },
      }),
    );
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/export-jobs/job-1/download`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }), env, fetcher);

    expectSafeDownloadResponse(response, 'attachment; filename="episode-diagnostic-job-1.zip"');
    expect(response.headers.get("x-chalk-diagnostic-checksum")).toBe("a".repeat(64));
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed when hosted gateway configuration is incomplete", async () => {
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01`, { headers: { Cookie: "__Host-chalk_account=account-token" } }), { ...env, CHALK_EPISODE_DIAGNOSTICS_GATEWAY: undefined }, vi.fn());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "gateway.misconfigured" });
  });
});
