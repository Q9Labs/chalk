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
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
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

  it("checks the launch surfaces and supports environment-specific target overrides", () => {
    expect(__internal.DEFAULT_MONITORS).toEqual([
      expect.objectContaining({ key: "web.room", url: "https://chalkmeet.com/room", method: "GET" }),
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
      { key: "web.room", url: "https://web.staging.example/room" },
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
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/ops/ingest/monitor-results")) {
        ingestedStatuses.push(JSON.parse(String(init?.body)) as { monitor_key: string; status: string; error_code?: string });
        return createResponse(202, JSON.stringify({ ok: true }));
      }
      if (url === "https://sync.chalkmeet.com/readyz" && !syncReady) {
        return createResponse(503, "not ready");
      }
      return createResponse(200, "ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = createEnv({ CHECK_RETRIES: "0" });
    const failed = await runMonitorCycle(env, new Date("2026-04-14T12:00:00Z"));
    expect(failed).toMatchObject({ checked_count: 6, healthy_count: 5, failed_count: 1 });
    expect(ingestedStatuses).toContainEqual(expect.objectContaining({ monitor_key: "sync.readiness", status: "failed", error_code: "unexpected_status" }));

    syncReady = true;
    ingestedStatuses.length = 0;
    const recovered = await runMonitorCycle(env, new Date("2026-04-14T12:05:00Z"));
    expect(recovered).toMatchObject({ checked_count: 6, healthy_count: 6, failed_count: 0 });
    expect(ingestedStatuses).toContainEqual(expect.objectContaining({ monitor_key: "sync.readiness", status: "healthy" }));

    const publicResponse = await worker.fetch(new Request("https://chalk-uptime-worker.example/"), env);
    await expect(publicResponse.json()).resolves.toEqual({ ok: true, worker: "chalk-uptime-worker" });
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

  it("sends a twilio fallback alert when critical checks are healthy but ingest is impaired", async () => {
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
      return createResponse(200, "ok");
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(twilioCalls).toBe(0);

    const secondSummary = await runMonitorCycle(env, new Date("2026-04-14T12:06:00Z"));
    expect(secondSummary.failed_count).toBe(0);
    expect(secondSummary.twilio_alert_sent).toBe(true);
    expect(twilioCalls).toBe(1);
  });

  it("keeps running current checks when replay storage fails", async () => {
    const bucket: R2Bucket = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
      async list() {
        throw new Error("r2 list unavailable");
      },
    };

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
    const bucket: R2Bucket = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("r2 put unavailable");
      },
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/v1/ops/ingest/monitor-results")) {
          return createResponse(503, "ingest unavailable");
        }
        return createResponse(200, "ok");
      }),
    );

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
    const bucket: R2Bucket = {
      async get() {
        throw new Error("r2 get unavailable");
      },
      async put() {
        throw new Error("r2 put unavailable");
      },
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
    };

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
