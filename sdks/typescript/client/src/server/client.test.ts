import { describe, expect, it, vi } from "vitest";
import { createChalkServerClient } from "./client";
import { ChalkAPIError } from "./errors";

const tenantId = "11111111-1111-4111-8111-111111111111";
const roomId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const participantId = "44444444-4444-4444-8444-444444444444";

describe("createChalkServerClient", () => {
  it("maps routes, bodies, telemetry, authorization, and participant access", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ init, url: String(input) });
      if (String(input).endsWith("/participants")) return jsonResponse({ ...lifecycle(), access: accessWire() }, 201);
      if (String(input).endsWith("/access")) return jsonResponse(accessWire(), 201);
      if (String(input).endsWith("/remove")) return jsonResponse(removal(), 202);
      return jsonResponse(room(), 201);
    });
    const client = createChalkServerClient({
      apiKey: "chalk_sk_sentinel.secret",
      tenantId,
      apiBaseURL: "https://api.example.test/base-that-is-preserved/",
      fetch,
      headers: { Authorization: "Bearer wrong", "x-customer": "yes" },
      telemetry: { journeyId: "journey", rootJourneyId: "journey", traceparent: "00-11111111111111111111111111111111-2222222222222222-01", tracestate: "chalk=test" },
    });

    await client.rooms.create({ media_plane: "cf_sfu", name: "Room", slug: "room", status: "active" });
    const admission = await client.participants.admit(roomId, sessionId, {
      eligible_roles: ["participant"],
      initial_role: "participant",
      name: "Guest",
      participant_session_id: participantId,
    });
    const access = await client.participants.issueAccess(roomId, sessionId, participantId, {
      participantSessionGeneration: 2,
      currentMediaToken: "current-media-token",
    });
    const removed = await client.participants.remove(roomId, sessionId, participantId, { participantSessionGeneration: 2 }, { idempotencyKey: "remove-participant" });

    expect(requests.map(({ url }) => url)).toEqual([
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/rooms`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/rooms/${roomId}/sessions/${sessionId}/participants`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/rooms/${roomId}/sessions/${sessionId}/participants/${participantId}/access`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/rooms/${roomId}/sessions/${sessionId}/participants/${participantId}/remove`,
    ]);
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer chalk_sk_sentinel.secret");
    expect(headers.get("x-chalk-journey-id")).toBe("journey");
    expect(headers.get("traceparent")).toContain("11111111111111111111111111111111");
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ current_media_token: "current-media-token", participant_session_generation: 2, replace_media_connection: false });
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({ participant_session_generation: 2 });
    expect(new Headers(requests[3]?.init?.headers).get("idempotency-key")).toBe("remove-participant");
    expect(admission.access).toEqual(access);
    expect(access.subject).toEqual({ tenantId, roomId, sessionId, participantSessionId: participantId, participantGeneration: 2 });
    expect(removed.participant.status).toBe("removing");
  });

  it("uses the exact bounded retry matrix and preserves a supplied idempotency key", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls: RequestInit[] = [];
    const responses: Array<Response | Error> = [new Error("offline"), jsonResponse({ error: { code: "busy", message: "ignored" } }, 503), jsonResponse({ api_keys: [], pagination: { has_more: false, next_cursor: null, page_size: 20 } }, 200)];
    const client = createChalkServerClient({
      apiKey: "chalk_sk_retry.secret",
      tenantId,
      apiBaseURL: "https://api.example.test",
      fetch: vi.fn(async (_input, init) => {
        calls.push(init ?? {});
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response!;
      }),
    });

    await expect(client.apiKeys.list()).resolves.toMatchObject({ api_keys: [] });
    expect(calls).toHaveLength(3);

    const sessionCalls: RequestInit[] = [];
    const sessionClient = createChalkServerClient({
      apiKey: "chalk_sk_retry.secret",
      tenantId,
      apiBaseURL: "https://api.example.test",
      fetch: vi.fn(async (_input, init) => {
        sessionCalls.push(init ?? {});
        return sessionCalls.length < 3 ? jsonResponse({ error: { code: "busy" } }, 503) : jsonResponse(session(), 201);
      }),
    });
    await sessionClient.sessions.create(roomId, sessionInput(), { idempotencyKey: "stable-key" });
    expect(sessionCalls).toHaveLength(3);
    expect(sessionCalls.map((init) => new Headers(init.headers).get("idempotency-key"))).toEqual(["stable-key", "stable-key", "stable-key"]);
  });

  it("never retries a one-time-secret response and exposes no cause or server message", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: "service_unavailable", message: "chalk_sk_do-not-echo" } }, 503, { "x-request-id": "request-safe" }));
    const client = createChalkServerClient({ apiKey: "chalk_sk_secret.value", tenantId, apiBaseURL: "https://api.example.test", fetch });

    const failure = client.apiKeys.create({ expiresAt: "2027-01-01T00:00:00Z", name: "backend", scopes: ["rooms:write"] });
    await expect(failure).rejects.toMatchObject({ code: "service_unavailable", requestId: "request-safe", retryable: true, status: 503 });
    await failure.catch((error: ChalkAPIError) => {
      expect(error.message).not.toContain("chalk_sk_");
      expect("cause" in error).toBe(false);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a lost media-connection replacement response", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("response lost after the server replaced the connection");
    });
    const client = createChalkServerClient({ apiKey: "chalk_sk_secret.value", tenantId, apiBaseURL: "https://api.example.test", fetch });

    await expect(
      client.participants.issueAccess(roomId, sessionId, participantId, {
        participantSessionGeneration: 2,
        replaceMediaConnection: true,
      }),
    ).rejects.toMatchObject({ code: "network_error", retryable: true, status: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ participant_session_generation: 2, replace_media_connection: true });
  });

  it("retries an ordinary access refresh after a lost response", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(jsonResponse(accessWire(), 201));
    const client = createChalkServerClient({ apiKey: "chalk_sk_secret.value", tenantId, apiBaseURL: "https://api.example.test", fetch });

    await expect(
      client.participants.issueAccess(roomId, sessionId, participantId, {
        participantSessionGeneration: 2,
        currentMediaToken: "current-media-token",
      }),
    ).resolves.toMatchObject({ media: { clientPayload: { connectionId: "connection" } } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { current_media_token: "current-media-token", participant_session_generation: 2, replace_media_connection: false },
      { current_media_token: "current-media-token", participant_session_generation: 2, replace_media_connection: false },
    ]);
  });
});

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function room() {
  return { created_at: "2026-01-01T00:00:00Z", created_by_user_id: null, id: roomId, media_plane: "cf_sfu", metadata: null, name: "Room", recurring_policy: null, slug: "room", status: "active", tenant_id: tenantId, updated_at: "2026-01-01T00:00:00Z" };
}

function session() {
  return { created_at: "2026-01-01T00:00:00Z", created_by_user_id: null, ended_at: null, id: sessionId, metadata: null, room_id: roomId, started_at: "2026-01-01T00:00:00Z", status: "active", tenant_id: tenantId, updated_at: "2026-01-01T00:00:00Z" };
}

function sessionInput() {
  return { admission_policy: "open", host_exit_policy: "continue", maximum_duration_seconds: 3600, role_capabilities: {} };
}

function lifecycle() {
  return {
    lifecycle_intent: { created_at: "2026-01-01T00:00:00Z", id: "55555555-5555-4555-8555-555555555555", intent_name: "join", participant_session_generation: 2, participant_session_id: participantId, request_key: "request", status: "applied" },
    participant: { generation: 2, id: participantId, room_id: roomId, session_id: sessionId, status: "active", tenant_id: tenantId },
  };
}

function removal() {
  return { lifecycle_intent: lifecycle().lifecycle_intent, participant: { ...lifecycle().participant, status: "removing" } };
}

function accessWire() {
  return {
    subject: { tenant_id: tenantId, room_id: roomId, session_id: sessionId, participant_session_id: participantId, participant_generation: 2 },
    sync: { token: "sync-token", expires_at: "2026-01-01T00:05:00Z" },
    media: { token: "media-token", expires_at: "2026-01-01T00:05:00Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection", stunServer: "stun:example.test" } },
  };
}
