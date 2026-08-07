// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { EpisodeDiagnosticsApiClient, EpisodeDiagnosticsApiError } from "./api-client";
import { deltaFixture, snapshotFixture, TEST_FILTER, TEST_FILTER_FINGERPRINT, TEST_REFERENCE } from "./test-fixtures";

function mockFetchSequence(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}

describe("EpisodeDiagnosticsApiClient", () => {
  it("starts SSE after the supplied durable cursor and verifies the SSE ID", async () => {
    const delta = deltaFixture(12);
    const fetch = vi.fn().mockResolvedValue(new Response(`id: 12\nevent: delta\ndata: ${JSON.stringify(delta)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });
    const received: ReturnType<typeof deltaFixture>[] = [];

    for await (const item of client.stream(TEST_REFERENCE, 11, TEST_FILTER)) received.push(item);

    expect(received).toEqual([delta]);
    const [, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(init.headers).toMatchObject({ "last-event-id": "11" });
    expect(String(fetch.mock.calls[0]?.[0])).toContain("after=11");
  });

  it("rejects an SSE ID that disagrees with the payload cursor", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(`id: 99\ndata: ${JSON.stringify(deltaFixture(12))}\n\n`, { status: 200 }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    await expect(async () => {
      for await (const _item of client.stream(TEST_REFERENCE, 11, TEST_FILTER)) void _item;
    }).rejects.toThrow(EpisodeDiagnosticsApiError);
  });

  it("accepts stream control separately and surfaces the authoritative close cursor", async () => {
    const control = { schemaVersion: "DiagnosticStreamControl/v1", heartbeatIntervalSeconds: 15, maxConnectionSeconds: 1800, afterCursor: 11, filterFingerprint: TEST_FILTER_FINGERPRINT, maxPendingDeltas: 100 };
    const close = { schemaVersion: "DiagnosticStreamClose/v1", reason: "server_shutdown", resumableCursor: 12, refillRequired: true };
    const fetch = vi.fn().mockResolvedValue(new Response(`event: control\ndata: ${JSON.stringify(control)}\n\nid: 12\nevent: delta\ndata: ${JSON.stringify(deltaFixture(12))}\n\nevent: close\ndata: ${JSON.stringify(close)}\n\n`, { status: 200 }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });
    const received: ReturnType<typeof deltaFixture>[] = [];

    const consume = async () => {
      for await (const item of client.stream(TEST_REFERENCE, 11, TEST_FILTER)) received.push(item);
    };

    await expect(consume()).rejects.toMatchObject({ reason: "server_shutdown", resumableCursor: 12, refillRequired: true });
    expect(received).toEqual([deltaFixture(12)]);
  });

  it("sends filters on the bounded snapshot request", async () => {
    const snapshot = snapshotFixture(4);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ kind: "diagnostic", reference: TEST_REFERENCE, snapshot }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    await client.readSnapshot(TEST_REFERENCE, TEST_FILTER);

    expect(String(fetch.mock.calls[0]?.[0])).toContain("filters=");
  });

  it("returns an export download URL instead of fetching a giant Blob", () => {
    const fetch = vi.fn();
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    const url = client.exportDownloadUrl(TEST_REFERENCE, "job-1");

    expect(url).toContain("/export-jobs/job-1/download");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the same-origin gateway without putting a bearer token in browser headers", async () => {
    const snapshot = snapshotFixture(4);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ kind: "diagnostic", reference: TEST_REFERENCE, snapshot }), { status: 200 }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    await client.readSnapshot(TEST_REFERENCE, TEST_FILTER);

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe(globalThis.location.origin);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.credentials).toBe("same-origin");
  });

  it("renders Markdown from the parsed brief instead of trusting server Markdown", async () => {
    const brief = {
      schemaVersion: "AgentBrief/v1",
      version: 1,
      reference: TEST_REFERENCE,
      captureTime: "2026-08-04T10:00:00.000Z",
      observedSummary: "Safe structured summary",
      environment: "localhost",
      resolverCommand: `pnpm trace:inspect ${TEST_REFERENCE} --format agent`,
      releaseCommits: [],
      visibleGaps: [],
      counts: { events: 1 },
      omissions: ["credentials omitted"],
    };
    const fetch = vi.fn().mockResolvedValue(Response.json({ schemaVersion: "AgentBriefResponse/v1", format: "markdown", brief, markdown: "password=secret token=secret credential=secret" }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    const response = await client.readBrief(TEST_REFERENCE, "markdown");

    expect(response.markdown).toContain("Safe structured summary");
    expect(response.markdown).not.toContain("password=secret");
    expect(response.markdown).not.toContain("token=secret");
    expect(response.markdown).not.toContain("credential=secret");
  });

  it("refuses a cross-origin browser gateway", () => {
    expect(() => new EpisodeDiagnosticsApiClient({ fetch: vi.fn(), basePath: "https://api.example.test/_internal/episode-diagnostics" })).toThrow("same-origin environment gateway");
  });

  it("resolves an alternate safe ID through the same-origin gateway", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "DiagnosticReference/v1", reference: TEST_REFERENCE }), { status: 200 }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    await expect(client.resolveAlternate("chalk.journey:journey01")).resolves.toBe(TEST_REFERENCE);

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe(globalThis.location.origin);
    expect(url.pathname).toContain("/resolve/chalk.journey%3Ajourney01");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("obtains the account CSRF token before an export mutation", async () => {
    const fetch = mockFetchSequence(Response.json({ csrf_token: "csrf-token" }), Response.json(exportJobFixture()));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    await client.createExportJob(TEST_REFERENCE, 11);

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/auth/csrf", expect.objectContaining({ credentials: "same-origin" }));
    const [, init] = fetch.mock.calls[1] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-chalk-csrf")).toBe("csrf-token");
    expect(init.credentials).toBe("same-origin");
  });

  it("refreshes the CSRF token once when the account boundary rejects a mutation", async () => {
    const fetch = mockFetchSequence(Response.json({ csrf_token: "stale-token" }), Response.json({ code: "csrf_mismatch", message: "Refresh CSRF" }, { status: 403 }), Response.json({ csrf_token: "fresh-token" }), Response.json(exportJobFixture()));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    await client.createExportJob(TEST_REFERENCE, 11);

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(new Headers((fetch.mock.calls[1]?.[1] as RequestInit).headers).get("x-chalk-csrf")).toBe("stale-token");
    expect(new Headers((fetch.mock.calls[3]?.[1] as RequestInit).headers).get("x-chalk-csrf")).toBe("fresh-token");
  });

  it("preserves the bounded time and branch context on AgentBrief requests", async () => {
    const brief = {
      schemaVersion: "AgentBrief/v1",
      version: 1,
      reference: TEST_REFERENCE,
      captureTime: "2026-08-04T10:00:00.000Z",
      observedSummary: "Bounded evidence",
      environment: "localhost",
      resolverCommand: `pnpm trace:inspect ${TEST_REFERENCE}`,
      releaseCommits: [],
      visibleGaps: [],
      counts: { events: 1 },
      omissions: [],
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "AgentBriefResponse/v1", format: "compact", brief }), { status: 200 }));
    const client = new EpisodeDiagnosticsApiClient({ fetch });

    await client.readBrief(TEST_REFERENCE, "compact", { cursor: 8, aroundSeconds: 30, branchId: "branch-1" });

    const url = fetch.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get("cursor")).toBe("8");
    expect(url.searchParams.get("around_seconds")).toBe("30");
    expect(url.searchParams.get("branch_id")).toBe("branch-1");
  });
});

function exportJobFixture() {
  return {
    schemaVersion: "ExportJob/v1",
    jobId: "job-1",
    reference: TEST_REFERENCE,
    state: "queued",
    createdAt: "2026-08-04T10:00:00.000Z",
    leaseEndsAt: "2026-08-04T10:05:00.000Z",
    cursorFrom: 0,
    cursorTo: 11,
  } as const;
}
