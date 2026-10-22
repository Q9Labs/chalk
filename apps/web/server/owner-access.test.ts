import { afterEach, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { createChalkEffectClient, TenantIdSchema } from "@q9labsai/chalk-client/effect";
import { configuration } from "./config";
import { seal, writeCookie } from "./cookies";
import { ownerAccess } from "./owner-access";
import type { Identity } from "./identity";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("recovers a superseded owner grant once (recovery also superseded: %s)", async (recoveryFails) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const env = configuration({
    CHALK_ENVIRONMENT: "test", CHALK_API_ORIGIN: "https://engine.example.test", DASHBOARD_ORIGIN: "https://dashboard.example.test",
    GOOGLE_CLIENT_ID: "google", GOOGLE_CLIENT_SECRET: "secret", APPLE_SERVICES_ID: "apple", APPLE_TEAM_ID: "team", APPLE_KEY_ID: "key", APPLE_PRIVATE_KEY: "key",
    SESSION_SECRET: "a-session-secret-with-at-least-32-characters", DASHBOARD_SERVICE_TOKEN: "service", DASHBOARD_IDENTITY_PROVIDER: "fixture",
  });
  const tenantId = Schema.decodeUnknownSync(TenantIdSchema)("11111111-1111-4111-8111-111111111111");
  const spaceId = "22222222-2222-4222-8222-222222222222";
  const episodeId = "33333333-3333-4333-8333-333333333333";
  const participantId = "44444444-4444-4444-8444-444444444444";
  const identity: Identity = { provider: "google", userId: "owner", sessionId: "session", name: "Owner", email: "owner@example.test", avatarUrl: null, expiresAt: Date.now() + 60000 };
  const cookie = new Response();
  writeCookie(cookie, env, `seat_${spaceId}`, await seal({ userId: identity.userId, sessionId: identity.sessionId, spaceId, episodeId, participantId, generation: 1, expiresAt: identity.expiresAt }, env.SESSION_SECRET, "owner-seat"));
  const request = new Request(env.DASHBOARD_ORIGIN, { headers: { Cookie: cookie.headers.get("Set-Cookie")?.split(";")[0] ?? "" } });
  const access = {
    subject: { tenant_id: tenantId, space_id: spaceId, episode_id: episodeId, participant_id: participantId, participant_generation: 1 },
    sync: { token: "sync", expires_at: "2026-10-22T15:00:00Z" },
    media: { token: "recovered", expires_at: "2026-10-22T15:00:00Z", provider: "cf_sfu", client_payload: { connectionId: "replacement" } },
  };
  const payloads: unknown[] = [];
  const api = await Effect.runPromise(createChalkEffectClient({ baseUrl: env.CHALK_API_ORIGIN, fetch: async (input, init) => {
    payloads.push(await new Request(input, init).json());
    const failed = payloads.length === 1 || recoveryFails;
    return Response.json(failed ? { error: { code: "participant.connection_superseded", message: "Superseded" } } : access, { status: failed ? 409 : 201 });
  } }));
  const result = ownerAccess(request, env, { api, tenantId, dashboardOrigin: env.DASHBOARD_ORIGIN }, identity, { action: "refresh-access", spaceId, currentMediaToken: "lost-response-old-token" });
  if (recoveryFails) await expect(result).rejects.toMatchObject({ status: 409 });
  else expect(await (await result).json()).toEqual({ access });
  expect(payloads).toEqual([
    { participant_generation: 1, replace_media_connection: false, current_media_token: "lost-response-old-token" },
    { participant_generation: 1, replace_media_connection: true },
  ]);
});
