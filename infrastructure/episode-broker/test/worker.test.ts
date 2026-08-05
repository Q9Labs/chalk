import { describe, expect, it, vi } from "vitest";

import type { DurableObjectNamespaceLike, DurableObjectStubLike, WorkerEnv } from "../src/contracts";
import { handleBrokerRequest } from "../src/worker";

const spaceInviteToken = "i".repeat(43);
const participantCredentialId = "p".repeat(43);

describe("Episode broker Worker boundary", () => {
  it("exposes a public health check without accepting mutation methods", async () => {
    const harness = workerHarness();
    const response = await harness.request("/local-chalk/health", { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "chalk-episode-broker", status: "ok" });

    const rejected = await harness.request("/local-chalk/health", { method: "POST" });
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("GET");
  });

  it("requires the exact origin, JSON content type, narrow body, and body cap", async () => {
    const harness = workerHarness();
    expect((await harness.post("/local-chalk/participant-credentials", { displayName: "Ada" }, { origin: "https://attacker.test" })).status).toBe(403);
    expect((await harness.request("/local-chalk/participant-credentials", { method: "POST", headers: { origin: "https://chalkmeet.com", "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await harness.post("/local-chalk/participant-credentials", { displayName: "Ada", tenantId: "injected" })).status).toBe(400);
    expect((await harness.request("/local-chalk/participant-credentials", { method: "POST", headers: { origin: "https://chalkmeet.com", "content-type": "application/json", "content-length": "8193" }, body: "{}" })).status).toBe(413);
    expect(harness.stub.fetch).not.toHaveBeenCalled();
  });

  it("creates an unguessable Space invite and secure browser credential without logging either", async () => {
    const harness = workerHarness(jsonResponse({ apiBaseURL: "https://api.chalkmeet.com", syncURL: "wss://sync.chalkmeet.com/v1/sync" }, 201));
    const response = await harness.post("/local-chalk/participant-credentials", { displayName: "Ada" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { readonly spaceInviteToken: string };
    expect(body.spaceInviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(harness.namespace.idFromName).toHaveBeenCalledWith(body.spaceInviteToken);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__Secure-chalk_participant_credential=${body.spaceInviteToken}.`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/local-chalk");
    const internal = await internalBody(harness.stub);
    expect(internal).toMatchObject({ action: "create", displayName: "Ada" });
    expect(String(harness.log.mock.calls)).not.toContain(body.spaceInviteToken);
    expect(String(harness.log.mock.calls)).not.toContain(internal.participantCredentialId);
  });

  it("routes Space invite joins and AccessGrant refreshes to the named Episode lease without browser-supplied identity", async () => {
    const harness = workerHarness(jsonResponse({ apiBaseURL: "https://api.chalkmeet.com", syncURL: "wss://sync.chalkmeet.com/v1/sync" }, 201));
    const joined = await harness.post("/local-chalk/participant-credentials", { displayName: "Grace", spaceInviteToken });
    expect(joined.status).toBe(201);
    expect(harness.namespace.idFromName).toHaveBeenCalledWith(spaceInviteToken);
    expect(await internalBody(harness.stub)).toMatchObject({ action: "join", displayName: "Grace" });

    harness.stub.fetch.mockResolvedValueOnce(jsonResponse({ access: "opaque" }, 201));
    const refreshed = await harness.post("/local-chalk/access-grants", { currentMediaToken: "opaque-media", replaceMediaConnection: true }, { cookie: `__Secure-chalk_participant_credential=${spaceInviteToken}.${participantCredentialId}` });
    expect(refreshed.status).toBe(201);
    const body = await internalBody(harness.stub);
    expect(body).toMatchObject({ participantCredentialId, currentMediaToken: "opaque-media", replaceMediaConnection: true });
    expect(body).not.toHaveProperty("participantId");
    expect(body).not.toHaveProperty("tenantId");
  });

  it("resumes a Space invite only when its secure browser credential matches", async () => {
    const harness = workerHarness(jsonResponse({ apiBaseURL: "https://api.chalkmeet.com", syncURL: "wss://sync.chalkmeet.com/v1/sync" }, 201));
    const resumed = await harness.post("/local-chalk/participant-credentials", { displayName: "Ada", spaceInviteToken }, { cookie: `__Secure-chalk_participant_credential=${spaceInviteToken}.${participantCredentialId}` });
    expect(resumed.status).toBe(201);
    expect(await internalBody(harness.stub)).toMatchObject({ action: "resume", participantCredentialId, displayName: "Ada" });
    expect(resumed.headers.get("set-cookie")).toContain(`${spaceInviteToken}.${participantCredentialId}`);

    await harness.post("/local-chalk/participant-credentials", { displayName: "Grace", spaceInviteToken }, { cookie: `__Secure-chalk_participant_credential=${"x".repeat(43)}.${participantCredentialId}` });
    expect(await internalBody(harness.stub)).toMatchObject({ action: "join", displayName: "Grace" });
  });

  it("clears the secure browser credential and rejects missing credentials and rate-limited creation", async () => {
    const harness = workerHarness(new Response(null, { status: 204 }));
    const missing = await harness.post("/local-chalk/access-grants", {});
    expect(missing.status).toBe(401);

    const cleaned = await harness.post("/local-chalk/participant-credentials/cleanup", {}, { cookie: `__Secure-chalk_participant_credential=${spaceInviteToken}.${participantCredentialId}` });
    expect(cleaned.status).toBe(204);
    expect(cleaned.headers.get("set-cookie")).toContain("Max-Age=0");

    harness.stub.fetch.mockResolvedValueOnce(jsonResponse({ error: "temporary failure" }, 502));
    const failed = await harness.post("/local-chalk/participant-credentials/cleanup", {}, { cookie: `__Secure-chalk_participant_credential=${spaceInviteToken}.${participantCredentialId}` });
    expect(failed.status).toBe(502);
    expect(failed.headers.get("set-cookie")).toBeNull();

    harness.env.CREATE_RATE_LIMITER.limit = vi.fn().mockResolvedValue({ success: false });
    const limited = await harness.post("/local-chalk/participant-credentials", { displayName: "Ada" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("issues opaque Participant credentials and AccessGrants without relying on browser cookies", async () => {
    const harness = workerHarness(jsonResponse({ apiBaseURL: "https://api.chalkmeet.com", syncURL: "wss://sync.chalkmeet.com/v1/sync" }, 201));
    const created = await harness.nativePost("/local-chalk/participant-credentials", { displayName: "Ada" });
    expect(created.status).toBe(201);
    const credential = (await created.json()) as { readonly participantCredentialId: string; readonly spaceInviteToken: string };
    expect(credential.participantCredentialId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(credential.spaceInviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await internalBody(harness.stub)).toMatchObject({ action: "create", participantCredentialId: credential.participantCredentialId, displayName: "Ada" });

    harness.stub.fetch.mockResolvedValueOnce(jsonResponse({ subject: { participantId: "participant-1" } }, 201));
    const access = await harness.nativePost("/local-chalk/access-grants", {
      participantCredentialId: credential.participantCredentialId,
      spaceInviteToken: credential.spaceInviteToken,
      replaceMediaConnection: true,
    });
    expect(access.status).toBe(201);
    expect(await internalBody(harness.stub)).toMatchObject({ participantCredentialId: credential.participantCredentialId, replaceMediaConnection: true });

    harness.stub.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const cleaned = await harness.nativePost("/local-chalk/participant-credentials/cleanup", { participantCredentialId: credential.participantCredentialId, spaceInviteToken: credential.spaceInviteToken });
    expect(cleaned.status).toBe(204);
    expect(await internalBody(harness.stub)).toMatchObject({ participantCredentialId: credential.participantCredentialId });
  });

  it("rejects malformed Participant credentials and untrusted browser callers", async () => {
    const harness = workerHarness();
    expect((await harness.post("/local-chalk/participant-credentials", { displayName: "Ada" }, { origin: "https://attacker.test" })).status).toBe(403);
    expect((await harness.nativePost("/local-chalk/access-grants", { participantCredentialId: "short", spaceInviteToken, replaceMediaConnection: false })).status).toBe(401);
    expect(harness.stub.fetch).not.toHaveBeenCalled();
  });
});

function workerHarness(stubResponse: Response = jsonResponse({}, 201)) {
  const stub = { fetch: vi.fn<(request: Request) => Promise<Response>>().mockResolvedValue(stubResponse) } satisfies DurableObjectStubLike;
  const namespace = {
    idFromName: vi.fn<(name: string) => unknown>((name) => name),
    get: vi.fn<DurableObjectNamespaceLike["get"]>(() => stub),
  } satisfies DurableObjectNamespaceLike;
  const env = {
    CHALK_API_KEY: "test-api-key",
    CHALK_API_URL: "https://api.chalkmeet.com",
    CHALK_APP_ORIGIN: "https://chalkmeet.com",
    CHALK_EPISODE_DEADLINE_SECONDS: "3600",
    CHALK_SPACE_ID: "test-space",
    CHALK_SYNC_URL: "wss://sync.chalkmeet.com/v1/sync",
    CHALK_TENANT_ID: "test-tenant",
    CREATE_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EPISODE_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EPISODE_LEASES: namespace,
  } satisfies WorkerEnv;
  const log = vi.fn();
  return {
    env,
    log,
    namespace,
    stub,
    request: (path: string, init?: RequestInit) => handleBrokerRequest(new Request(`https://chalkmeet.com${path}`, init), env, log),
    post: (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
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

async function internalBody(stub: { readonly fetch: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } } }): Promise<Record<string, unknown>> {
  const request = stub.fetch.mock.calls.at(-1)?.[0] as Request | undefined;
  if (!request) throw new Error("Expected an internal Durable Object request");
  return (await request.clone().json()) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
