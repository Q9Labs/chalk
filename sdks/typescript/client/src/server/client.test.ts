import { describe, expect, it } from "vitest";

import { createChalkServerClient } from "./client";

const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const credential = (audience: string) => `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
const expiresAt = "2030-01-01T00:00:00.000Z";

const grantWire = (telemetry?: unknown) => ({
  subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 1 },
  sync: { token: credential("chalk-sync"), expires_at: expiresAt },
  media: { token: credential("chalk-media"), expires_at: expiresAt, provider: "chalk_sfu", client_payload: { connectionId: "connection-1", episodeRef: "episode-ref-1" } },
  ...(telemetry === undefined ? {} : { telemetry }),
});

const issueAccess = (body: unknown) => {
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
  const client = createChalkServerClient({ apiKey: "key", tenantId: "tenant-1", apiBaseURL: "https://api.test", fetch });
  return client.participants.issueAccess("space-1", "episode-1", "participant-1", { participantGeneration: 1, currentMediaToken: "token" });
};

describe("issueAccess", () => {
  it("keeps the telemetry credential of the grant", async () => {
    const token = credential("chalk-telemetry");
    const grant = await issueAccess(grantWire({ token, expires_at: expiresAt }));
    expect(grant.telemetry).toEqual({ token, expires_at: expiresAt });
  });

  it("parses a grant from a server that predates the telemetry credential", async () => {
    const grant = await issueAccess(grantWire());
    expect(grant.telemetry).toBeUndefined();
    expect(grant.media.provider).toBe("chalk_sfu");
  });
});

const captureRequest = async (invoke: (client: ReturnType<typeof createChalkServerClient>) => Promise<unknown>, responseBody: unknown = {}) => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    const method = init?.method ?? "GET";
    const url = String(input);
    const status = method === "DELETE" ? 204 : method === "POST" && url.includes("/recordings/") && url.endsWith("/transcripts") ? 202 : method === "POST" && (url.endsWith("/participants") || url.endsWith("/redeliver")) ? 201 : 200;
    if (status === 204) return new Response(null, { status });
    return typeof responseBody === "string" ? new Response(responseBody, { status }) : new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  };
  const client = createChalkServerClient({ apiKey: "key", tenantId: "tenant-1", apiBaseURL: "https://api.test", fetch });
  await invoke(client);
  const call = calls[0];
  return { url: String(call.input), init: call.init, body: call.init?.body === undefined ? undefined : JSON.parse(String(call.init.body)), headers: new Headers(call.init?.headers) };
};

describe("server resource serializers", () => {
  it("sends participant admission and Space metadata", async () => {
    const admission = await captureRequest((client) => client.participants.admit("space-1", "episode-1", { admission: "policy", name: "Ari", role: "guest" }));
    expect(admission.url).toBe("https://api.test/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants");
    expect(admission.body).toMatchObject({ admission: "policy", name: "Ari", role: "guest" });

    const space = await captureRequest((client) => client.spaces.update("space-1", { metadata: { owner: "backend" }, recordingPolicy: "manual" }));
    expect(space.init?.method).toBe("PATCH");
    expect(space.body).toMatchObject({ metadata: { owner: "backend" }, recording_policy: "manual" });
  });

  it("covers transcript routes, including plain text and on-demand requests", async () => {
    const list = await captureRequest((client) => client.transcripts.list({ recordingId: "recording-1", pageSize: 10 }));
    expect(list.url).toBe("https://api.test/v1/tenants/tenant-1/transcripts?page_size=10&recording_id=recording-1");
    const text = await captureRequest((client) => client.transcripts.text("transcript-1"), "hello transcript");
    expect(text.url).toBe("https://api.test/v1/tenants/tenant-1/transcripts/transcript-1/text");
    const request = await captureRequest((client) => client.transcripts.request("recording-1", { idempotencyKey: "key-1", languages: ["en"] }));
    expect(request.url).toBe("https://api.test/v1/tenants/tenant-1/recordings/recording-1/transcripts");
    expect(request.body).toMatchObject({ idempotency_key: "key-1", languages: ["en"] });
    expect(request.headers.get("idempotency-key")).toBe("key-1");
  });

  it("covers webhook endpoint mutations, filters and redelivery", async () => {
    const update = await captureRequest((client) => client.webhookEndpoints.update("endpoint-1", { revision: 7, enabled: false }, { idempotencyKey: "update-1" }));
    expect(update.headers.get("if-match")).toBe("7");
    expect(update.headers.get("idempotency-key")).toBe("update-1");
    expect(update.body).toMatchObject({ enabled: false });
    const deliveries = await captureRequest((client) => client.webhookEndpoints.listDeliveries("endpoint-1", { states: ["exhausted"], eventTypes: ["transcript.completed"] }));
    expect(deliveries.url).toBe("https://api.test/v1/tenants/tenant-1/webhook-endpoints/endpoint-1/deliveries?event_type=transcript.completed&state=exhausted");
    const redelivery = await captureRequest((client) => client.webhookEndpoints.redeliver("endpoint-1", "delivery-1", { idempotencyKey: "redeliver-1" }));
    expect(redelivery.url).toBe("https://api.test/v1/tenants/tenant-1/webhook-endpoints/endpoint-1/deliveries/delivery-1/redeliver");
  });

  it("puts, gets and deletes Scheduled Episodes", async () => {
    const put = await captureRequest((client) =>
      client.scheduledEpisodes.put("space-1", "018f0000-0000-7000-8000-000000000001", { startsAt: "2030-01-01T10:00:00Z", expectedEndsAt: "2030-01-01T11:00:00Z", expectedParticipants: [{ name: "Ari", identityExternalId: "person-1" }], metadata: { source: "service" } }),
    );
    expect(put.init?.method).toBe("PUT");
    expect(put.url).toBe("https://api.test/v1/tenants/tenant-1/spaces/space-1/scheduled-episodes/018f0000-0000-7000-8000-000000000001");
    expect(put.body).toMatchObject({ starts_at: "2030-01-01T10:00:00Z", expected_ends_at: "2030-01-01T11:00:00Z", expected_participants: [{ name: "Ari", identity_external_id: "person-1" }] });
    const del = await captureRequest((client) => client.scheduledEpisodes.delete("space-1", "018f0000-0000-7000-8000-000000000001"));
    expect(del.init?.method).toBe("DELETE");
  });
});
