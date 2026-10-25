import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { AdmitEpisodeParticipantPathParamsSchema, createChalkEffectClient, TenantIdSchema, DateTimeStringSchema } from "@q9labsai/chalk-client/effect";
import { run, withSessionEngine } from "./engine";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";

const privateDetail = "private-response-token-email-and-name";
afterEach(() => vi.restoreAllMocks());

const env: DashboardEnvironment = {
  CHALK_ENVIRONMENT: "test",
  CHALK_API_ORIGIN: "http://127.0.0.1:8788",
  DASHBOARD_ORIGIN: "http://localhost:8789",
  GOOGLE_CLIENT_ID: "fixture",
  GOOGLE_CLIENT_SECRET: "fixture",
  APPLE_SERVICES_ID: "fixture",
  APPLE_TEAM_ID: "fixture",
  APPLE_KEY_ID: "fixture",
  APPLE_PRIVATE_KEY: "fixture",
  SESSION_SECRET: "fixture-session-key-with-at-least-32-characters",
  DASHBOARD_SERVICE_TOKEN: "fixture",
  DASHBOARD_IDENTITY_PROVIDER: "fixture",
};
const person: Identity = { provider: "google", userId: "subject", sessionId: "session", name: "Person", email: "person@example.test", avatarUrl: null, expiresAt: Date.now() + 60_000 };
const tenantId = "11111111-1111-4111-8111-111111111111";
function tenantLookup() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      id: tenantId,
      name: "Personal",
      external_id: "google:test:subject",
      cors_allowed_origins: [],
      recording_render_mode: "on_demand",
      default_media_plane: null,
      media_plane_provider_config: null,
      storage_provider_config: null,
      logo_key: null,
      website: null,
      transcription_ceiling: "on_demand",
      transcription_default_mode: "on_demand",
      provider_policy_version: "test",
      recording_retention_seconds: 3600,
      transcript_retention_seconds: 3600,
      transcription_source_window_seconds: 3600,
      created_at: "2026-10-18T12:00:00Z",
      updated_at: "2026-10-18T12:00:00Z",
    }),
  );
}
async function tenantCookie() {
  const response = await withSessionEngine(new Request(env.DASHBOARD_ORIGIN), env, person, async (engine) => Response.json({ tenantId: engine.tenantId }));
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("tenant cache was not set");
  return cookie;
}

it("resolves a tenant once per session across independent polling requests", async () => {
  const lookup = tenantLookup();
  const cookie = await tenantCookie();
  for (let tick = 0; tick < 12; tick++) {
    const response = await withSessionEngine(new Request(env.DASHBOARD_ORIGIN, { headers: { Cookie: cookie } }), env, person, async (engine) => Response.json({ tenantId: engine.tenantId }));
    expect(await response.json()).toEqual({ tenantId });
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  expect(lookup).toHaveBeenCalledOnce();
});

it.each([
  { name: "session", identity: { ...person, sessionId: "another-session" }, environment: env },
  { name: "account", identity: { ...person, userId: "another-user" }, environment: env },
  { name: "provider", identity: { ...person, provider: "apple" as const }, environment: env },
  { name: "environment", identity: person, environment: { ...env, CHALK_ENVIRONMENT: "local" as const } },
  { name: "engine", identity: person, environment: { ...env, CHALK_API_ORIGIN: "http://127.0.0.1:9999" } },
])("does not reuse tenant authority for another $name", async ({ identity, environment }) => {
  const lookup = tenantLookup();
  const cookie = await tenantCookie();
  await withSessionEngine(new Request(env.DASHBOARD_ORIGIN, { headers: { Cookie: cookie } }), environment, identity, async () => new Response());
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("rejects a modified tenant cache and renews an expired one", async () => {
  const lookup = tenantLookup();
  const cookie = await tenantCookie();
  await expect(withSessionEngine(new Request(env.DASHBOARD_ORIGIN, { headers: { Cookie: cookie + "tampered" } }), env, person, async () => new Response())).rejects.toMatchObject({ status: 401 });
  vi.spyOn(Date, "now").mockReturnValue(person.expiresAt + 1);
  await withSessionEngine(new Request(env.DASHBOARD_ORIGIN, { headers: { Cookie: cookie } }), env, { ...person, expiresAt: person.expiresAt + 60_000 }, async () => new Response());
  expect(lookup).toHaveBeenCalledTimes(2);
});

describe("engine failure diagnostics through the real SDK decoder", () => {
  it.each([
    { code: "api_key.invalid_expiry", expected: "api_key_invalid_expiry" },
    { code: "request.invalid", expected: "invalid_request" },
  ])("keeps key validation $code terminal instead of asking the person to retry", async ({ code, expected }) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await Effect.runPromise(
      createChalkEffectClient({
        baseUrl: "https://engine.example.test",
        fetch: async () => Response.json({ error: { code, message: privateDetail } }, { status: 400 }),
      }),
    );
    await expect(
      run(
        api.default.createAPIKey({
          params: { tenant_id: Schema.decodeUnknownSync(TenantIdSchema)(tenantId) },
          headers: { "Idempotency-Key": "expiry-validation" },
          payload: { name: "Test", scopes: ["spaces:read"], expires_at: Schema.decodeUnknownSync(DateTimeStringSchema)("2027-10-25T23:59:00Z") },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: expected });
  });
  it.each([
    { code: "participant.not_active", expected: { status: 409, code: "participant_not_active" } },
    { code: privateDetail, expected: { status: 502, code: "engine_unavailable" } },
  ])("handles the admission transport code $code", async ({ code, expected }) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await Effect.runPromise(createChalkEffectClient({ baseUrl: "https://engine.example.test", fetch: async () => Response.json({ error: { code, message: privateDetail } }, { status: 409 }) }));
    const params = Schema.decodeUnknownSync(AdmitEpisodeParticipantPathParamsSchema)({ tenant_id: "11111111-1111-4111-8111-111111111111", space_id: "22222222-2222-4222-8222-222222222222", episode_id: "33333333-3333-4333-8333-333333333333" });
    await expect(run(api.episodes.admitEpisodeParticipant({ params, headers: { "Idempotency-Key": "admission-compatibility-probe" }, payload: { name: "Owner", role: "host" } }))).rejects.toMatchObject(expected);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "dashboard.engine_failed", engine_status: 409, sdk_error_tag: "HttpClientError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
  });

  it.each([
    { status: 503, body: JSON.stringify({ error: { code: "service.unavailable", message: privateDetail } }), expected: { engine_code: "service.unavailable" } },
    { status: 400, body: JSON.stringify({ error: { code: "request.invalid", message: privateDetail } }), expected: { engine_code: "request.invalid" } },
    { status: 502, body: privateDetail, expected: { engine_status: 502, sdk_error_tag: "HttpClientError", sdk_error_reason: "DecodeError" } },
    { status: 201, body: JSON.stringify({ unexpected: privateDetail }), expected: { sdk_error_tag: "SchemaError" } },
  ])("logs a bounded cause for a $status response without its contents", async ({ status, body, expected }) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await Effect.runPromise(createChalkEffectClient({ baseUrl: "https://engine.example.test", fetch: async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }) }));
    await expect(run(api.tenants.createTenant({ payload: { name: privateDetail } }))).rejects.toMatchObject({ status: 502, code: "engine_unavailable" });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "dashboard.engine_failed", ...expected });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
  });

  it("logs the SDK transport tag without the network error message", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await Effect.runPromise(
      createChalkEffectClient({
        baseUrl: "https://engine.example.test",
        fetch: async () => {
          throw new TypeError(privateDetail);
        },
      }),
    );
    await expect(run(api.tenants.createTenant({ payload: { name: privateDetail } }))).rejects.toMatchObject({ status: 502, code: "engine_unavailable" });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "dashboard.engine_failed", sdk_error_tag: "HttpClientError", sdk_error_reason: "TransportError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
  });
});
