import { describe, expect, it, vi } from "vitest";
import { createChalkServerClient } from "./client";
import { ChalkAPIError } from "./errors";

const tenantId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const participantId = "44444444-4444-4444-8444-444444444444";

describe("createChalkServerClient", () => {
  it("preserves the global receiver required by edge-runtime fetch", async () => {
    const edgeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(space(), 201));
    });
    vi.stubGlobal("fetch", edgeFetch);

    try {
      const client = createChalkServerClient({ apiKey: "chalk_sk_edge.secret", tenantId, apiBaseURL: "https://api.example.test" });
      await expect(client.spaces.create(spaceInput())).resolves.toMatchObject({ id: spaceId });
      expect(edgeFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps canonical routes, bodies, telemetry, authorization, and access grants", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ init, url: String(input) });
      if (String(input).endsWith("/participants")) return jsonResponse({ ...lifecycle(), access: accessWire() }, 201);
      if (String(input).endsWith("/access-grant")) return jsonResponse(accessWire(), 201);
      if (String(input).endsWith("/remove")) return jsonResponse(removal(), 202);
      if (String(input).endsWith("/end")) return jsonResponse(episodeEnd(), 202);
      if (String(input).endsWith("/episodes")) return jsonResponse(episode(), 201);
      return jsonResponse(space(), 201);
    });
    const client = createChalkServerClient({
      apiKey: "chalk_sk_sentinel.secret",
      tenantId,
      apiBaseURL: "https://api.example.test/base-that-is-preserved/",
      fetch,
      headers: { Authorization: "Bearer wrong", "x-customer": "yes" },
      telemetry: { journeyId: "journey", rootJourneyId: "journey", traceparent: "00-11111111111111111111111111111111-2222222222222222-01", tracestate: "chalk=test" },
    });

    const createdSpace = await client.spaces.create(spaceInput());
    const createdEpisode = await client.episodes.create(spaceId, episodeInput());
    const admission = await client.participants.admit(spaceId, episodeId, {
      name: "Guest",
      participantId,
      role: "collaborator",
    });
    const access = await client.participants.issueAccess(spaceId, episodeId, participantId, {
      participantGeneration: 2,
      currentMediaToken: "current-media-token",
    });
    const removed = await client.participants.remove(spaceId, episodeId, participantId, { participantGeneration: 2 }, { idempotencyKey: "remove-participant" });
    const ended = await client.episodes.end(spaceId, episodeId, { idempotencyKey: "end-episode" });

    expect(requests.map(({ url }) => url)).toEqual([
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/spaces`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/spaces/${spaceId}/episodes`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/participants`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/participants/${participantId}/access-grant`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/participants/${participantId}/remove`,
      `https://api.example.test/base-that-is-preserved/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/end`,
    ]);
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer chalk_sk_sentinel.secret");
    expect(headers.get("x-chalk-journey-id")).toBe("journey");
    expect(headers.get("traceparent")).toContain("11111111111111111111111111111111");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ default_episode_duration_seconds: 3600, linger_window_seconds: 120, maximum_episode_duration_seconds: 7200, media_plane: "cf_sfu", name: "Space", slug: "space" });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ metadata: { source: "test" }, started_at: "2026-01-01T00:00:00Z" });
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ name: "Guest", participant_id: participantId, role: "collaborator" });
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({ current_media_token: "current-media-token", participant_generation: 2, replace_media_connection: false });
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({ participant_generation: 2 });
    expect(new Headers(requests[4]?.init?.headers).get("idempotency-key")).toBe("remove-participant");
    expect(new Headers(requests[5]?.init?.headers).get("idempotency-key")).toBe("end-episode");
    expect(createdSpace).toMatchObject({ id: spaceId, maximum_episode_duration_seconds: 7200 });
    expect(createdEpisode).toMatchObject({ id: episodeId, space_id: spaceId });
    expect(admission.access).toEqual(access);
    expect(JSON.parse(JSON.stringify(access))).toEqual({
      subject: { tenant_id: tenantId, space_id: spaceId, episode_id: episodeId, participant_id: participantId, participant_generation: 2 },
      sync: { token: expect.any(String), expires_at: "2026-01-01T00:05:00Z" },
      media: {
        token: expect.any(String),
        expires_at: "2026-01-01T00:05:00Z",
        provider: "cloudflare_sfu",
        client_payload: { connectionId: "connection", stunServer: "stun:example.test" },
      },
    });
    expect(removed).toMatchObject({ external_operation: { target_participant_id: participantId }, participant: { status: "removing" } });
    expect(ended).toEqual(episodeEnd());
  });

  it("preserves diagnostics credentials on admission and access refresh grants", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/participants")) return jsonResponse({ ...lifecycle(), access: accessWire(true) }, 201);
      return jsonResponse(accessWire(true), 201);
    });
    const client = createChalkServerClient({ apiKey: "chalk_sk_secret.value", tenantId, apiBaseURL: "https://api.example.test", fetch });

    const admission = await client.participants.admit(spaceId, episodeId, { name: "Guest", participantId, role: "collaborator" });
    const access = await client.participants.issueAccess(spaceId, episodeId, participantId, { participantGeneration: 2, currentMediaToken: "current-media-token" });
    const expectedDiagnostics = {
      token: expect.any(String),
      expires_at: "2026-01-01T00:05:00Z",
      generation: 2,
      intake_path: "/_internal/episode-diagnostic-events",
    };

    expect(admission.access).toMatchObject({ diagnostics: expectedDiagnostics });
    expect(access).toMatchObject({ diagnostics: expectedDiagnostics });
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

    const episodeCalls: RequestInit[] = [];
    const episodeClient = createChalkServerClient({
      apiKey: "chalk_sk_retry.secret",
      tenantId,
      apiBaseURL: "https://api.example.test",
      fetch: vi.fn(async (_input, init) => {
        episodeCalls.push(init ?? {});
        return episodeCalls.length < 3 ? jsonResponse({ error: { code: "busy" } }, 503) : jsonResponse(episode(), 201);
      }),
    });
    await episodeClient.episodes.create(spaceId, episodeInput(), { idempotencyKey: "stable-key" });
    expect(episodeCalls).toHaveLength(3);
    expect(episodeCalls.map((init) => new Headers(init.headers).get("idempotency-key"))).toEqual(["stable-key", "stable-key", "stable-key"]);
  });

  it("never retries a one-time-secret response and exposes no cause or server message", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: "service_unavailable", message: "chalk_sk_do-not-echo" } }, 503, { "x-request-id": "request-safe" }));
    const client = createChalkServerClient({ apiKey: "chalk_sk_secret.value", tenantId, apiBaseURL: "https://api.example.test", fetch });

    const failure = client.apiKeys.create({ expiresAt: "2027-01-01T00:00:00Z", name: "backend", scopes: ["spaces:write"] });
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
      client.participants.issueAccess(spaceId, episodeId, participantId, {
        participantGeneration: 2,
        replaceMediaConnection: true,
      }),
    ).rejects.toMatchObject({ code: "network_error", retryable: true, status: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ participant_generation: 2, replace_media_connection: true });
  });

  it("retries an ordinary access refresh after a lost response", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(jsonResponse(accessWire(), 201));
    const client = createChalkServerClient({ apiKey: "chalk_sk_secret.value", tenantId, apiBaseURL: "https://api.example.test", fetch });

    await expect(
      client.participants.issueAccess(spaceId, episodeId, participantId, {
        participantGeneration: 2,
        currentMediaToken: "current-media-token",
      }),
    ).resolves.toMatchObject({ media: { client_payload: { connectionId: "connection" } } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { current_media_token: "current-media-token", participant_generation: 2, replace_media_connection: false },
      { current_media_token: "current-media-token", participant_generation: 2, replace_media_connection: false },
    ]);
  });
});

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function spaceInput() {
  return { defaultEpisodeDurationSeconds: 3600, lingerWindowSeconds: 120, maximumEpisodeDurationSeconds: 7200, mediaPlane: "cf_sfu", name: "Space", slug: "space" };
}

function space() {
  return {
    admission_policy: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by_user_id: null,
    default_episode_duration_seconds: 3600,
    id: spaceId,
    linger_window_seconds: 120,
    maximum_episode_duration_seconds: 7200,
    media_plane: "cf_sfu",
    metadata: null,
    name: "Space",
    recurring_policy: null,
    roles: [],
    slug: "space",
    tenant_id: tenantId,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function episode() {
  return {
    config_snapshot: {},
    created_at: "2026-01-01T00:00:00Z",
    deadline_at: "2026-01-01T02:00:00Z",
    deadline_generation: 1,
    id: episodeId,
    metadata: { source: "test" },
    space_id: spaceId,
    started_at: "2026-01-01T00:00:00Z",
    status: "active",
    tenant_id: tenantId,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function episodeInput() {
  return { metadata: { source: "test" }, startedAt: "2026-01-01T00:00:00Z" };
}

function episodeEnd() {
  return {
    episode_id: episodeId,
    external_operation: { created_at: "2026-01-01T00:00:00Z", id: "55555555-5555-4555-8555-555555555555", operation_name: "end_episode", request_key: "request", status: "pending" },
    status: "ending",
  };
}

function lifecycle() {
  return {
    lifecycle_intent: { created_at: "2026-01-01T00:00:00Z", id: "55555555-5555-4555-8555-555555555555", intent_name: "join", participant_generation: 2, participant_id: participantId, request_key: "request", status: "applied" },
    participant: { capabilities: ["publishAudio"], episode_id: episodeId, generation: 2, id: participantId, role: "collaborator", space_id: spaceId, status: "active", tenant_id: tenantId },
  };
}

function removal() {
  return {
    external_operation: { created_at: "2026-01-01T00:00:00Z", id: "55555555-5555-4555-8555-555555555555", operation_name: "remove_participant", request_key: "request", status: "pending", target_participant_generation: 2, target_participant_id: participantId },
    participant: { ...lifecycle().participant, status: "removing" },
  };
}

function accessWire(withDiagnostics = false) {
  return {
    subject: { tenant_id: tenantId, space_id: spaceId, episode_id: episodeId, participant_id: participantId, participant_generation: 2 },
    sync: { token: accessToken("chalk-sync"), expires_at: "2026-01-01T00:05:00Z" },
    media: { token: accessToken("chalk-media"), expires_at: "2026-01-01T00:05:00Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection", stunServer: "stun:example.test" } },
    ...(withDiagnostics ? { diagnostics: diagnosticsWire() } : {}),
  };
}

function diagnosticsWire() {
  return { token: accessToken("chalk-diagnostics"), expires_at: "2026-01-01T00:05:00Z", generation: 2, intake_path: "/_internal/episode-diagnostic-events" };
}

function accessToken(audience: "chalk-sync" | "chalk-media" | "chalk-diagnostics"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ aud: audience })}.signature`;
}
