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

describe("Episode Diagnostics gateway", () => {
  it("requires same-origin account access and forwards only the account bearer", async () => {
    const rejectedFetcher = vi.fn();
    const rejected = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01`, { headers: { Origin: "https://evil.test", Cookie: "__Host-chalk_account=account-token" } }), env, rejectedFetcher);
    expect(rejected.status).toBe(403);
    expect(rejectedFetcher).not.toHaveBeenCalled();

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(new Response("id: 4\nevent: close\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream", authorization: "Bearer upstream-secret" } }));
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/stream?after=3&discarded=secret`, {
        headers: { Cookie: "__Host-chalk_account=account-token", Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01" },
      }),
      env,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: close");
    expect(response.headers.get("authorization")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://api.chalk.test/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/stream?after=3");
    const diagnosticHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(diagnosticHeaders.get("authorization")).toBe("Bearer account-token");
    expect(diagnosticHeaders.get("cookie")).toBeNull();
    expect(diagnosticHeaders.get("traceparent")).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  });

  it("requires CSRF proof for export mutations before contacting upstream", async () => {
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
    await expect(response.json()).resolves.toMatchObject({ code: "csrf.mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("follows an allowlisted signed download without returning credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://downloads.chalk.test/diagnostics/job-1?signature=secret" } }))
      .mockResolvedValueOnce(new Response("redacted bundle", { status: 200, headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="episode-diagnostic-job-1.gz"', authorization: "Bearer secret", "set-cookie": "opaque=secret" } }));
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/export-jobs/job-1/download`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }), env, fetcher);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("redacted bundle");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="episode-diagnostic-job-1.gz"');
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("authorization")).toBeNull();
    expect(fetcher.mock.calls[2]?.[1]?.credentials).toBe("omit");
  });

  it("rejects a signed download redirect outside the configured hosts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://evil.test/diagnostics/job-1?signature=secret" } }));
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/export-jobs/job-1/download`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }), env, fetcher);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "download.redirect_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an upstream JSON response is malformed", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: "account-1" } }))
      .mockResolvedValueOnce(new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }));
    const response = await handleEpisodeDiagnosticsGateway(new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Astaging%3Adiag01/stream`, { headers: { Cookie: "__Host-chalk_account=account-token" } }), env, fetcher);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "upstream.contract_error" });
  });

  it("fails closed when production hosting lacks its explicit opt-in", async () => {
    const fetcher = vi.fn();
    const response = await handleEpisodeDiagnosticsGateway(
      new Request(`${origin}/_internal/episode-diagnostics/chalkdiag%3Av1%3Aproduction%3Adiag01`, { headers: { Cookie: "__Host-chalk_account=account-token", Origin: origin } }),
      { ...env, CHALK_ENVIRONMENT: "production", CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN: undefined },
      fetcher,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "gateway.misconfigured" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
