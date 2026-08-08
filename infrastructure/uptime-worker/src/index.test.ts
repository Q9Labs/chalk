import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { __internal, runMonitorCycle, type Env } from "./index";

function createResponse(status: number, body = "", headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", responseHeaders.get("cache-control") ?? "no-store");
  responseHeaders.set("x-chalk-journey-id", responseHeaders.get("x-chalk-journey-id") ?? "test-journey");
  return new Response(body, {
    status,
    headers: responseHeaders,
  });
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_BASE_URL: "https://api.chalkmeet.com",
    OPS_INGEST_TOKEN: "ops-ingest-token",
    ...overrides,
  };
}

const INGEST_PATH = "/v1/ops/ingest/monitor-results";
const TWILIO_PATH = "api.twilio.com/2010-04-01/Accounts";
type FetchInput = string | URL | Request;
type FetchResponder = (url: string, init?: RequestInit) => Response | Promise<Response>;

function requestURL(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function stubFetch(responder: FetchResponder) {
  const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => responder(requestURL(input), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubHealthyFetch() {
  return stubFetch((url) => (url.includes(INGEST_PATH) ? createResponse(202, JSON.stringify({ ok: true })) : createResponse(200, "ok")));
}

function stubFailedIngestFetch() {
  return stubFetch((url) => (url.includes(INGEST_PATH) ? createResponse(503, "ingest unavailable") : createResponse(200, "ok")));
}

function stubTwilioFallbackFetch(checkStatus: number): () => number {
  let twilioCallCount = 0;
  stubFetch((url) => {
    if (url.includes(TWILIO_PATH)) {
      twilioCallCount += 1;
      return createResponse(201, JSON.stringify({ sid: "SM123" }));
    }
    if (url.includes(INGEST_PATH)) return createResponse(503, "ingest unavailable");
    return createResponse(checkStatus, checkStatus === 200 ? "ok" : "check failed");
  });
  return () => twilioCallCount;
}

type FailureBucketMode = "replay" | "buffer" | "critical";

function createFailureBucket(mode: FailureBucketMode): R2Bucket {
  return {
    async get() {
      if (mode === "critical") throw new Error("r2 get unavailable");
      return null;
    },
    async put() {
      if (mode !== "replay") throw new Error("r2 put unavailable");
    },
    async delete() {},
    async list() {
      if (mode === "replay") throw new Error("r2 list unavailable");
      return { objects: [], truncated: false };
    },
  };
}

function createInMemoryBucket(): { bucket: R2Bucket; stored: Map<string, string> } {
  const stored = new Map<string, string>();
  const bucket: R2Bucket = {
    async get(key) {
      const value = stored.get(key);
      return value
        ? {
            async text() {
              return value;
            },
          }
        : null;
    },
    async put(key, value) {
      stored.set(key, value);
    },
    async delete(key) {
      stored.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix ?? "";
      return {
        objects: Array.from(stored.keys())
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };

  return { bucket, stored };
}

describe("chalk ops monitor worker", () => {
  beforeEach(() => {
    __internal.resetForTests();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("runs all default checks and ingests their results", async () => {
    const fetchMock = stubFetch((url) => (url.includes(INGEST_PATH) ? createResponse(202, JSON.stringify({ ok: true }), { "content-type": "application/json" }) : createResponse(200, "ok")));

    const summary = await runMonitorCycle(createEnv(), new Date("2026-04-14T12:00:00Z"));

    expect(summary.checked_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.failed_count).toBe(0);
    expect(summary.ingest_success_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.ingest_failure_count).toBe(0);

    const ingestCalls = fetchMock.mock.calls.filter(([target]) => String(target).includes("/v1/ops/ingest/monitor-results"));
    expect(ingestCalls).toHaveLength(__internal.DEFAULT_MONITORS.length);
  });

  it("creates and propagates safe journey and W3C trace context while keeping the ingest token out of payloads", async () => {
    const context = {
      journeyID: "11111111-1111-4111-8111-111111111111",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "chalk=test",
    };
    const fetchMock = stubFetch((url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-chalk-journey-id")).toBe(context.journeyID);
      expect(headers.get("traceparent")).toBe(context.traceparent);
      expect(headers.get("tracestate")).toBe(context.tracestate);
      if (url.includes(INGEST_PATH)) {
        const body = String(init?.body);
        expect(headers.get("Idempotency-Key")).toBe(JSON.parse(body).result_key);
        expect(headers.get("X-Ops-Ingest-Token")).toBe("ops-ingest-token");
        expect(body).not.toContain("ops-ingest-token");
        return createResponse(202, JSON.stringify({ ok: true }));
      }
      return createResponse(200, "ok");
    });

    await runMonitorCycle(createEnv(), new Date("2026-04-14T12:00:00Z"), context);

    expect(fetchMock).toHaveBeenCalled();
  });

  it("creates context for scheduled cycles when no inbound request exists", async () => {
    let ingestHeaders: Headers | undefined;
    stubFetch((url, init) => {
      if (url.includes(INGEST_PATH)) ingestHeaders = new Headers(init?.headers);
      return createResponse(url.includes(INGEST_PATH) ? 202 : 200, "ok");
    });

    await runMonitorCycle(createEnv(), new Date("2026-04-14T12:00:00Z"));

    expect(ingestHeaders?.get("x-chalk-journey-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ingestHeaders?.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(ingestHeaders?.get("tracestate")).toBe("chalk=uptime-worker");
  });

  it("checks the launch surfaces and supports environment-specific target overrides", () => {
    expect(__internal.DEFAULT_MONITORS).toEqual([
      expect.objectContaining({ key: "web.space", url: "https://chalkmeet.com/space", method: "GET" }),
      expect.objectContaining({ key: "web.account_boundary", url: "https://chalkmeet.com/api/healthz", method: "GET" }),
      expect.objectContaining({ key: "api.health", url: "https://api.chalkmeet.com/healthz", method: "GET" }),
      expect.objectContaining({ key: "api.readiness", url: "https://api.chalkmeet.com/readyz", method: "GET" }),
      expect.objectContaining({ key: "sync.health", url: "https://sync.chalkmeet.com/healthz", method: "GET" }),
      expect.objectContaining({ key: "sync.readiness", url: "https://sync.chalkmeet.com/readyz", method: "GET" }),
      expect.objectContaining({ key: "broker.health", url: "https://chalkmeet.com/local-chalk/health", method: "GET" }),
    ]);

    const overridden = __internal.monitorDefinitions({
      API_MONITOR_BASE_URL: "https://api.staging.example/base?secret=redacted",
      BROKER_BASE_URL: "https://broker.staging.example/private#fragment",
      SYNC_BASE_URL: "https://sync.staging.example/ignored",
      WEB_BASE_URL: "https://web.staging.example/ignored",
    });
    expect(overridden.map(({ key, url }) => ({ key, url }))).toEqual([
      { key: "web.space", url: "https://web.staging.example/space" },
      { key: "web.account_boundary", url: "https://web.staging.example/api/healthz" },
      { key: "api.health", url: "https://api.staging.example/healthz" },
      { key: "api.readiness", url: "https://api.staging.example/readyz" },
      { key: "sync.health", url: "https://sync.staging.example/healthz" },
      { key: "sync.readiness", url: "https://sync.staging.example/readyz" },
      { key: "broker.health", url: "https://broker.staging.example/local-chalk/health" },
    ]);
  });

  it("ingests failed and recovered component status without exposing it from the public worker response", async () => {
    let syncReady = false;
    const ingestedStatuses: Array<{ monitor_key: string; status: string; error_code?: string }> = [];
    stubFetch((url, init) => {
      if (url.includes(INGEST_PATH)) {
        ingestedStatuses.push(JSON.parse(String(init?.body)) as { monitor_key: string; status: string; error_code?: string });
        return createResponse(202, JSON.stringify({ ok: true }));
      }
      if (url === "https://sync.chalkmeet.com/readyz" && !syncReady) {
        return createResponse(503, "not ready");
      }
      return createResponse(200, "ok");
    });

    const env = createEnv({ CHECK_RETRIES: "0" });
    const failed = await runMonitorCycle(env, new Date("2026-04-14T12:00:00Z"));
    expect(failed).toMatchObject({ checked_count: 7, healthy_count: 6, failed_count: 1 });
    expect(ingestedStatuses).toContainEqual(expect.objectContaining({ monitor_key: "sync.readiness", status: "failed", error_code: "unexpected_status" }));

    syncReady = true;
    ingestedStatuses.length = 0;
    const recovered = await runMonitorCycle(env, new Date("2026-04-14T12:05:00Z"));
    expect(recovered).toMatchObject({ checked_count: 7, healthy_count: 7, failed_count: 0 });
    expect(ingestedStatuses).toContainEqual(expect.objectContaining({ monitor_key: "sync.readiness", status: "healthy" }));

    const publicResponse = await worker.fetch(new Request("https://chalk-uptime-worker.example/"), env);
    await expect(publicResponse.json()).resolves.toEqual({ ok: true, worker: "chalk-uptime-worker" });
  });

  it("buffers failed ingests when an R2 bucket binding is present", async () => {
    const { bucket, stored } = createInMemoryBucket();
    stubFetch((url) => (url.includes(INGEST_PATH) ? createResponse(503, "temporary failure") : createResponse(200, "ok")));

    const summary = await runMonitorCycle(
      createEnv({
        OPS_FALLBACK_BUFFER_BUCKET: bucket,
        RETRY_BACKOFF_MS: "0",
      }),
      new Date("2026-04-14T12:01:00Z"),
    );

    expect(summary.ingest_failure_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.buffered_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(stored.size).toBeGreaterThan(0);
    const records = Array.from(stored.entries())
      .filter(([key]) => key.includes("/failed-ingest/"))
      .map(([, value]) => JSON.parse(value) as { trace_context?: Record<string, unknown> });
    expect(records.every((record) => typeof record.trace_context?.journeyID === "string")).toBe(true);
    expect(records.every((record) => typeof record.trace_context?.traceparent === "string")).toBe(true);
    expect(records.every((record) => typeof record.trace_context?.tracestate === "string")).toBe(true);
  });

  it("replays buffered ingest records before current checks", async () => {
    const { bucket, stored } = createInMemoryBucket();
    stored.set(
      "ops-monitor/failed-ingest/api.health/seed.json",
      JSON.stringify({
        payload: {
          result_key: "cf-uptime-worker:seed:api.health",
          run_id: "cf-uptime-worker:seed",
          monitor_key: "api.health",
          status: "failed",
          checked_at: "2026-04-14T12:00:00Z",
          event_at: "2026-04-14T12:00:00Z",
          latency_ms: 10,
          reported_source: "cloudflare-uptime-worker",
          reported_emitter_id: "chalk-uptime-worker",
          metadata: {},
          details: {},
        },
        trace_context: {
          journeyID: "11111111-1111-4111-8111-111111111111",
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
          tracestate: "chalk=seed",
        },
        buffered_at: "2026-04-14T12:00:00Z",
        error_code: "ingest_http_503",
        error_message: "seed failure",
      }),
    );

    const fetchMock = stubHealthyFetch();

    await runMonitorCycle(
      createEnv({
        OPS_FALLBACK_BUFFER_BUCKET: bucket,
      }),
      new Date("2026-04-14T12:02:00Z"),
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/ops/ingest/monitor-results");
    const replayHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(replayHeaders.get("x-chalk-journey-id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(replayHeaders.get("traceparent")).toBe("00-11111111111111111111111111111111-2222222222222222-01");
    expect(replayHeaders.get("tracestate")).toBe("chalk=seed");
    expect(Array.from(stored.keys()).some((key) => key.startsWith("ops-monitor/failed-ingest/"))).toBe(false);
  });

  it("sends a narrow twilio fallback alert after two consecutive critical ingest impairments", async () => {
    const { bucket } = createInMemoryBucket();
    const twilioCallCount = stubTwilioFallbackFetch(503);

    const env = createEnv({
      OPS_FALLBACK_BUFFER_BUCKET: bucket,
      CHECK_RETRIES: "0",
      INGEST_RETRIES: "0",
      RETRY_BACKOFF_MS: "0",
      OPS_TWILIO_ACCOUNT_SID: "AC123",
      OPS_TWILIO_AUTH_TOKEN: "auth-token",
      OPS_TWILIO_WHATSAPP_FROM: "+15550001111",
      OPS_WHATSAPP_TO_CRITICAL: "+15550002222",
    });

    await runMonitorCycle(env, new Date("2026-04-14T12:03:00Z"));
    expect(twilioCallCount()).toBe(0);

    await runMonitorCycle(env, new Date("2026-04-14T12:04:00Z"));
    expect(twilioCallCount()).toBe(1);
  });

  it("sends a twilio fallback alert when critical checks are healthy but ingest is impaired", async () => {
    const { bucket } = createInMemoryBucket();
    const twilioCallCount = stubTwilioFallbackFetch(200);

    const env = createEnv({
      OPS_FALLBACK_BUFFER_BUCKET: bucket,
      INGEST_RETRIES: "0",
      RETRY_BACKOFF_MS: "0",
      OPS_TWILIO_ACCOUNT_SID: "AC123",
      OPS_TWILIO_AUTH_TOKEN: "auth-token",
      OPS_TWILIO_WHATSAPP_FROM: "+15550001111",
      OPS_WHATSAPP_TO_CRITICAL: "+15550002222",
    });

    const firstSummary = await runMonitorCycle(env, new Date("2026-04-14T12:05:00Z"));
    expect(firstSummary.failed_count).toBe(0);
    expect(twilioCallCount()).toBe(0);

    const secondSummary = await runMonitorCycle(env, new Date("2026-04-14T12:06:00Z"));
    expect(secondSummary.failed_count).toBe(0);
    expect(secondSummary.twilio_alert_sent).toBe(true);
    expect(twilioCallCount()).toBe(1);
  });

  it("keeps running current checks when replay storage fails", async () => {
    const bucket = createFailureBucket("replay");
    stubHealthyFetch();

    const summary = await runMonitorCycle(
      createEnv({
        OPS_FALLBACK_BUFFER_BUCKET: bucket,
      }),
      new Date("2026-04-14T12:07:00Z"),
    );

    expect(summary.replay_failed).toBe(1);
    expect(summary.checked_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.ingest_success_count).toBe(__internal.DEFAULT_MONITORS.length);
  });

  it("keeps the run alive when buffering failed ingests fails", async () => {
    const bucket = createFailureBucket("buffer");
    stubFailedIngestFetch();

    const summary = await runMonitorCycle(
      createEnv({
        OPS_FALLBACK_BUFFER_BUCKET: bucket,
        INGEST_RETRIES: "0",
      }),
      new Date("2026-04-14T12:08:00Z"),
    );

    expect(summary.ingest_failure_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.buffered_count).toBe(0);
  });

  it("keeps the run alive when critical state storage fails", async () => {
    const bucket = createFailureBucket("critical");
    stubHealthyFetch();

    const summary = await runMonitorCycle(
      createEnv({
        OPS_FALLBACK_BUFFER_BUCKET: bucket,
      }),
      new Date("2026-04-14T12:09:00Z"),
    );

    expect(summary.checked_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.ingest_failure_count).toBe(0);
  });

  it("rejects manual fetch-triggered runs without the manual token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request("https://chalk-uptime-worker.example/run", { method: "POST" }), createEnv());

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports authorized manual fetch-triggered runs", async () => {
    stubHealthyFetch();

    const response = await worker.fetch(
      new Request("https://chalk-uptime-worker.example/run", {
        method: "POST",
        headers: {
          authorization: "Bearer manual-run-token",
        },
      }),
      createEnv({
        OPS_MANUAL_RUN_TOKEN: "manual-run-token",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      checked_count: __internal.DEFAULT_MONITORS.length,
    });
  });
});
