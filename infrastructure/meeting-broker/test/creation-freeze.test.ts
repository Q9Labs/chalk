import { describe, expect, it, vi } from "vitest";

import type { DurableObjectNamespaceLike, DurableObjectStubLike, WorkerEnv } from "../src/contracts";
import { handleBrokerRequest } from "../src/worker";

const inviteToken = "i".repeat(43);
const browserSessionId = "b".repeat(43);
const clientSessionId = "c".repeat(43);

describe("legacy creation freeze", () => {
  it("blocks only new browser and native credentials with bounded retry advice and telemetry", async () => {
    const harness = workerHarness(true);

    const browser = await harness.browserPost("/local-chalk/browser-session", { displayName: "Ada" });
    expect(browser.status).toBe(503);
    expect(browser.headers.get("retry-after")).toBe("60");
    expect(await browser.json()).toEqual({ error: "Legacy meeting creation is paused during cutover." });

    const native = await harness.nativePost("/local-chalk/client-session", { displayName: "Ada" });
    expect(native.status).toBe(503);
    expect(native.headers.get("retry-after")).toBe("60");
    expect(harness.stub.fetch).not.toHaveBeenCalled();
    expect(harness.log.mock.calls.filter(([event]) => event === "creation_frozen")).toHaveLength(2);
    expect(String(harness.log.mock.calls)).not.toContain(inviteToken);
    expect(String(harness.log.mock.calls)).not.toContain(browserSessionId);
  });

  it("keeps health, resume, access refresh, and cleanup available while frozen", async () => {
    const harness = workerHarness(true);
    expect((await harness.request("/local-chalk/health", { method: "GET" })).status).toBe(200);

    harness.stub.fetch.mockResolvedValueOnce(jsonResponse({ apiBaseURL: "https://api.chalkmeet.com", syncURL: "wss://sync.chalkmeet.com/v1/sync" }, 201));
    const browserResume = await harness.browserPost("/local-chalk/browser-session", { displayName: "Ada", inviteToken }, { cookie: `__Secure-chalk_session=${inviteToken}.${browserSessionId}` });
    expect(browserResume.status).toBe(201);
    expect(await lastInternalBody(harness.stub)).toMatchObject({ action: "resume", clientSessionId: browserSessionId });

    harness.stub.fetch.mockResolvedValueOnce(jsonResponse({ apiBaseURL: "https://api.chalkmeet.com", syncURL: "wss://sync.chalkmeet.com/v1/sync" }, 201));
    const nativeResume = await harness.nativePost("/local-chalk/client-session", { displayName: "Ada", inviteToken, clientSessionId });
    expect(nativeResume.status).toBe(201);
    expect(await lastInternalBody(harness.stub)).toMatchObject({ action: "resume", clientSessionId });

    harness.stub.fetch.mockResolvedValueOnce(jsonResponse({ access: "opaque" }, 201));
    const access = await harness.browserPost("/local-chalk/access", { replaceMediaConnection: true }, { cookie: `__Secure-chalk_session=${inviteToken}.${browserSessionId}` });
    expect(access.status).toBe(201);

    harness.stub.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const cleanup = await harness.browserPost("/local-chalk/cleanup", {}, { cookie: `__Secure-chalk_session=${inviteToken}.${browserSessionId}` });
    expect(cleanup.status).toBe(204);
    expect(cleanup.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

function workerHarness(frozen: boolean) {
  const stub = { fetch: vi.fn<(request: Request) => Promise<Response>>() } satisfies DurableObjectStubLike;
  const namespace = {
    idFromName: vi.fn<(name: string) => unknown>((name) => name),
    get: vi.fn<DurableObjectNamespaceLike["get"]>(() => stub),
  } satisfies DurableObjectNamespaceLike;
  const env = {
    CHALK_API_KEY: "test-api-key",
    CHALK_API_URL: "https://api.chalkmeet.com",
    CHALK_APP_ORIGIN: "https://chalkmeet.com",
    CHALK_LEGACY_CREATION_FREEZE: frozen ? "true" : "false",
    CHALK_ROOM_ID: "test-room",
    CHALK_SYNC_URL: "wss://sync.chalkmeet.com/v1/sync",
    CHALK_TENANT_ID: "test-tenant",
    CREATE_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    SESSION_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    MEETING_SESSIONS: namespace,
  } satisfies WorkerEnv;
  const log = vi.fn();
  return {
    env,
    log,
    stub,
    request: (path: string, init?: RequestInit) => handleBrokerRequest(new Request(`https://chalkmeet.com${path}`, init), env, log),
    browserPost: (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
      handleBrokerRequest(
        new Request(`https://chalkmeet.com${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://chalkmeet.com", ...headers },
          body: JSON.stringify(body),
        }),
        env,
        log,
      ),
    nativePost: (path: string, body: unknown) =>
      handleBrokerRequest(
        new Request(`https://chalkmeet.com${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        log,
      ),
  };
}

async function lastInternalBody(stub: { readonly fetch: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } } }): Promise<Record<string, unknown>> {
  const request = stub.fetch.mock.calls.at(-1)?.[0] as Request | undefined;
  if (!request) throw new Error("Expected an internal Durable Object request");
  return (await request.clone().json()) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
