import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { __internal, runMonitorCycle, type Env } from "./index";

function createResponse(status: number, body = "", headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers,
  });
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_BASE_URL: "https://chalk-api.q9labs.ai",
    OPS_INGEST_TOKEN: "ops-ingest-token",
    ...overrides,
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
  });

  it("runs all default checks and ingests their results", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/ops/ingest/monitor-results")) {
        return createResponse(202, JSON.stringify({ ok: true }), {
          "content-type": "application/json",
        });
      }
      return createResponse(200, "ok");
    });

    vi.stubGlobal("fetch", fetchMock);

    const summary = await runMonitorCycle(createEnv(), new Date("2026-04-14T12:00:00Z"));

    expect(summary.checked_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.failed_count).toBe(0);
    expect(summary.ingest_success_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.ingest_failure_count).toBe(0);

    const ingestCalls = fetchMock.mock.calls.filter(([target]) => String(target).includes("/api/v1/ops/ingest/monitor-results"));
    expect(ingestCalls).toHaveLength(__internal.DEFAULT_MONITORS.length);
  });

  it("buffers failed ingests when an R2 bucket binding is present", async () => {
    const { bucket, stored } = createInMemoryBucket();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/ops/ingest/monitor-results")) {
        return createResponse(503, "temporary failure");
      }
      return createResponse(200, "ok");
    });

    vi.stubGlobal("fetch", fetchMock);

    const summary = await runMonitorCycle(
      createEnv({
        OPS_FALLBACK_BUFFER_BUCKET: bucket,
      }),
      new Date("2026-04-14T12:01:00Z"),
    );

    expect(summary.ingest_failure_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(summary.buffered_count).toBe(__internal.DEFAULT_MONITORS.length);
    expect(stored.size).toBeGreaterThan(0);
  });

  it("replays buffered ingest records before current checks", async () => {
    const { bucket, stored } = createInMemoryBucket();
    stored.set(
      "ops-monitor/failed-ingest/api.health/seed.json",
      JSON.stringify({
        payload: {
          result_key: "cf-ops-monitor:seed:api.health",
          run_id: "cf-ops-monitor:seed",
          monitor_key: "api.health",
          status: "failed",
          checked_at: "2026-04-14T12:00:00Z",
          event_at: "2026-04-14T12:00:00Z",
          latency_ms: 10,
          reported_source: "cloudflare-ops-monitor",
          reported_emitter_id: "chalk-ops-monitor",
          metadata: {},
          details: {},
        },
        buffered_at: "2026-04-14T12:00:00Z",
        error_code: "ingest_http_503",
        error_message: "seed failure",
      }),
    );

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/ops/ingest/monitor-results")) {
        return createResponse(202, JSON.stringify({ ok: true }));
      }
      return createResponse(200, "ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    await runMonitorCycle(
      createEnv({
        OPS_FALLBACK_BUFFER_BUCKET: bucket,
      }),
      new Date("2026-04-14T12:02:00Z"),
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/ops/ingest/monitor-results");
    expect(Array.from(stored.keys()).some((key) => key.startsWith("ops-monitor/failed-ingest/"))).toBe(false);
  });

  it("sends a narrow twilio fallback alert after two consecutive critical ingest impairments", async () => {
    const { bucket } = createInMemoryBucket();
    let twilioCalls = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.twilio.com/2010-04-01/Accounts")) {
        twilioCalls += 1;
        return createResponse(201, JSON.stringify({ sid: "SM123" }));
      }
      if (url.includes("/api/v1/ops/ingest/monitor-results")) {
        return createResponse(503, "ingest unavailable");
      }
      return createResponse(503, "check failed");
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(twilioCalls).toBe(0);

    await runMonitorCycle(env, new Date("2026-04-14T12:04:00Z"));
    expect(twilioCalls).toBe(1);
  });

  it("supports manual fetch-triggered runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/v1/ops/ingest/monitor-results")) {
          return createResponse(202, JSON.stringify({ ok: true }));
        }
        return createResponse(200, "ok");
      }),
    );

    const response = await worker.fetch(new Request("https://chalk-ops-monitor.example/run", { method: "POST" }), createEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      checked_count: __internal.DEFAULT_MONITORS.length,
    });
  });
});
