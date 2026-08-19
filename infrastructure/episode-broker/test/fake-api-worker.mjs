const calls = [];
let episodeEndCalls = 0;
let spaceSequence = 0;
let spaceCreateFailures = 0;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/calls") return response(200, calls);
    if (request.method === "POST" && url.pathname === "/fail-next-space-creation") {
      spaceCreateFailures = 3;
      return new Response(null, { status: 204 });
    }
    const body = await request.json().catch(() => undefined);
    const call = { body, method: request.method, path: url.pathname, authorization: request.headers.get("authorization"), idempotencyKey: request.headers.get("idempotency-key") };
    calls.push(call);
    if (request.method === "POST" && url.pathname === "/v1/tenants/test-tenant/spaces") {
      if (spaceCreateFailures > 0) {
        spaceCreateFailures -= 1;
        return response(503, { error: { code: "dependency_unavailable" } });
      }
      spaceSequence += 1;
      const spaceId = `00000000-0000-4000-8000-${String(spaceSequence).padStart(12, "0")}`;
      call.spaceId = spaceId;
      return response(201, space(spaceId, body));
    }
    if (request.method === "POST" && url.pathname.endsWith("/archive")) return response(200, { ...space(spaceIdFrom(url.pathname), {}), archived: true, archived_at: new Date().toISOString() });
    if (url.pathname.endsWith("/episodes")) return response(201, { id: "episode-1" });
    if (url.pathname.endsWith("/participants")) {
      const participantId = body.participant_id;
      const spaceId = spaceIdFrom(url.pathname);
      return response(201, { lifecycle_intent: lifecycle(participantId), participant: participant(spaceId, participantId), access: access(spaceId, participantId) });
    }
    if (url.pathname.endsWith("/access-grant")) return response(201, access(spaceIdFrom(url.pathname), url.pathname.split("/").at(-2)));
    if (url.pathname.endsWith("/remove")) return response(202, { external_operation: { id: "operation-1" }, participant: { ...participant(spaceIdFrom(url.pathname), url.pathname.split("/").at(-2)), status: "removing" } });
    if (url.pathname.endsWith("/end")) {
      episodeEndCalls += 1;
      if (episodeEndCalls === 2) return response(409, { error: { code: "episode_not_active" } });
      return response(202, { external_operation: { id: "operation-1" }, episode_id: "episode-1", status: "ending" });
    }
    return response(404, { error: { code: "not_found" } });
  },
};

function space(id, body) {
  const now = new Date().toISOString();
  return {
    admission_policy: body.admission_policy ?? { mode: "open" },
    archived: false,
    archived_at: null,
    created_at: now,
    created_by_user_id: null,
    default_episode_duration_seconds: body.default_episode_duration_seconds ?? 3,
    id,
    linger_window_seconds: body.linger_window_seconds ?? 0,
    maximum_episode_duration_seconds: body.maximum_episode_duration_seconds ?? 3,
    media_plane: body.media_plane ?? "cf_sfu",
    metadata: body.metadata ?? {},
    name: body.name ?? "Space",
    recurring_policy: body.recurring_policy ?? null,
    roles: [],
    slug: body.slug ?? `open-${id}`,
    tenant_id: "test-tenant",
    updated_at: now,
  };
}

function spaceIdFrom(path) {
  const segments = path.split("/");
  return segments[segments.indexOf("spaces") + 1];
}

function response(status, body) {
  return Response.json(body, { status });
}

function lifecycle(participantId) {
  return { created_at: new Date().toISOString(), id: "intent-1", intent_name: "participant.join", participant_generation: 1, participant_id: participantId, request_key: "request-1", status: "applied" };
}

function participant(spaceId, participantId) {
  return { generation: 1, id: participantId, space_id: spaceId, episode_id: "episode-1", status: "active", tenant_id: "test-tenant" };
}

function access(spaceId, participantId) {
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  return {
    subject: { tenant_id: "test-tenant", space_id: spaceId, episode_id: "episode-1", participant_id: participantId, participant_generation: 1 },
    sync: { token: credential("chalk-sync"), expires_at: expiresAt },
    media: { token: credential("chalk-media"), expires_at: expiresAt, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:example.test" } },
  };
}

function credential(audience) {
  const encode = (json) => btoa(json).replace(/[+/=]/g, (character) => ({ "+": "-", "/": "_", "=": "" })[character] ?? "");
  return `${encode('{"alg":"EdDSA"}')}.${encode(`{"aud":"${audience}"}`)}.signature`;
}
