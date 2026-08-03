const calls = [];
let sessionEndCalls = 0;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/calls") return response(200, calls);
    const body = await request.json().catch(() => undefined);
    calls.push({ body, method: request.method, path: url.pathname, authorization: request.headers.get("authorization"), idempotencyKey: request.headers.get("idempotency-key") });
    if (url.pathname.endsWith("/episodes")) return response(201, { id: "episode-1" });
    if (url.pathname.endsWith("/participants")) {
      const participantId = body.participant_id;
      return response(201, { lifecycle_intent: lifecycle(participantId), participant: participant(participantId), access: access(participantId) });
    }
    if (url.pathname.endsWith("/access-grant")) return response(201, access(url.pathname.split("/").at(-2)));
    if (url.pathname.endsWith("/remove")) return response(202, { external_operation: { id: "operation-1" }, participant: { ...participant(url.pathname.split("/").at(-2)), status: "removing" } });
    if (url.pathname.endsWith("/end")) {
      sessionEndCalls += 1;
      if (sessionEndCalls === 2) return response(409, { error: { code: "episode_not_active" } });
      return response(202, { external_operation: { id: "operation-1" }, episode_id: "episode-1", status: "ending" });
    }
    return response(404, { error: { code: "not_found" } });
  },
};

function response(status, body) {
  return Response.json(body, { status });
}

function lifecycle(participantId) {
  return { created_at: new Date().toISOString(), id: "intent-1", intent_name: "participant.join", participant_generation: 1, participant_id: participantId, request_key: "request-1", status: "applied" };
}

function participant(participantId) {
  return { generation: 1, id: participantId, space_id: "test-room", episode_id: "episode-1", status: "active", tenant_id: "test-tenant" };
}

function access(participantId) {
  return {
    subject: { tenant_id: "test-tenant", space_id: "test-room", episode_id: "episode-1", participant_id: participantId, participant_generation: 1 },
    sync: { token: "sync-token", expires_at: "2026-07-22T18:00:00Z" },
    media: { token: "media-token", expires_at: "2026-07-22T18:00:00Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:example.test" } },
  };
}
