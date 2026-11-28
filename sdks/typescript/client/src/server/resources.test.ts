import { describe, expect, it } from "vitest";

import { createChalkServerClient } from "./index.js";

const tenantPath = "/v1/tenants/tenant-1";
const spacePath = `${tenantPath}/spaces/space%2F1`;
const episodePath = `${spacePath}/episodes/episode-1`;
const schedulePath = `${spacePath}/scheduled-episodes/schedule-1`;
const transcriptPath = `${tenantPath}/transcripts/transcript%2F1`;
const webhookPath = `${tenantPath}/webhook-endpoints/endpoint%2F1`;

function exampleServer(status: number, payload?: unknown) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    if (status === 204) return new Response(null, { status });
    if (typeof payload === "string") return new Response(payload, { status, headers: { "Content-Type": "text/plain" } });
    return Response.json(payload ?? {}, { status, headers: { "X-Request-ID": "request-1" } });
  };
  const client = createChalkServerClient({ apiKey: "test-key", tenantId: "tenant-1", apiBaseURL: "https://api.test", fetch, headers: { "If-Match": "outdated", "X-Extra": "retained" } });
  async function expectRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe(method);
    expect(request.url).toBe(`https://api.test${path}`);
    expect(request.headers.get("Authorization")).toBe("Bearer test-key");
    expect(request.headers.get("X-Extra")).toBe("retained");
    for (const [name, value] of Object.entries(headers ?? {})) expect(request.headers.get(name)).toBe(value);
    if (body === undefined) expect(request.body).toBeNull();
    else expect(await request.json()).toEqual(body);
    return request;
  }
  return { client, expectRequest };
}

describe("Space and Participant requests", () => {
  it("serializes Space metadata and both artifact policies together", async () => {
    const { client, expectRequest } = exampleServer(200, { metadata: null });
    expect((await client.spaces.update("space/1", { metadata: null, recordingPolicy: "automatic", transcriptionPolicy: "on_demand" })).metadata).toBeNull();
    await expectRequest("PATCH", spacePath, { metadata: null, recording_policy: "automatic", transcription_policy: "on_demand" });
  });

  it.each(["direct", "policy", undefined] as const)("preserves Participant admission %s", async (admission) => {
    const { client, expectRequest } = exampleServer(201, { participant: { id: "participant-1" } });
    const result = await client.participants.admit("space/1", "episode-1", { name: "Participant", role: "observer", ...(admission === undefined ? {} : { admission }) });
    expect(result.participant.id).toBe("participant-1");
    await expectRequest("POST", `${episodePath}/participants`, { name: "Participant", role: "observer", ...(admission === undefined ? {} : { admission }) });
  });
});

describe("Scheduled Episodes", () => {
  it("puts the full expectation under the caller's ID", async () => {
    const { client, expectRequest } = exampleServer(200, { id: "schedule-1" });
    const start = "2030-01-01T09:00:00Z";
    const end = "2030-01-01T10:00:00Z";
    const result = await client.scheduledEpisodes.put("space/1", "schedule-1", {
      startsAt: start,
      expectedEndsAt: end,
      expectedParticipants: [{ name: "Participant", identityExternalId: "person-1", role: "observer" }],
      metadata: { label: "planned" },
    });
    expect(result.id).toBe("schedule-1");
    await expectRequest("PUT", schedulePath, { starts_at: start, expected_ends_at: end, expected_participants: [{ name: "Participant", identity_external_id: "person-1", role: "observer" }], metadata: { label: "planned" } });
  });

  it("gets a Scheduled Episode", async () => {
    const { client, expectRequest } = exampleServer(200, { id: "schedule-1", status: "cancelled" });
    expect((await client.scheduledEpisodes.get("space/1", "schedule-1")).status).toBe("cancelled");
    await expectRequest("GET", schedulePath);
  });

  it("cancels without decoding the empty response", async () => {
    const { client, expectRequest } = exampleServer(204);
    expect(await client.scheduledEpisodes.delete("space/1", "schedule-1")).toBeUndefined();
    await expectRequest("DELETE", schedulePath);
  });
});

describe("Transcripts", () => {
  it("lists with pagination and a Recording filter", async () => {
    const { client, expectRequest } = exampleServer(200, { transcripts: [] });
    expect((await client.transcripts.list({ cursor: "cursor+1", pageSize: 5, recordingId: "recording/1" })).transcripts).toEqual([]);
    await expectRequest("GET", `${tenantPath}/transcripts?cursor=cursor%2B1&page_size=5&recording_id=recording%2F1`);
  });

  it("gets the Transcript resource", async () => {
    const { client, expectRequest } = exampleServer(200, { id: "transcript/1" });
    expect((await client.transcripts.get("transcript/1")).id).toBe("transcript/1");
    await expectRequest("GET", transcriptPath);
  });

  it("gets the structured document", async () => {
    const { client, expectRequest } = exampleServer(200, { cues: [{ text: "A line" }] });
    expect((await client.transcripts.getDocument("transcript/1")).cues[0].text).toBe("A line");
    await expectRequest("GET", `${transcriptPath}/document`);
  });

  it("gets plain text without JSON decoding", async () => {
    const { client, expectRequest } = exampleServer(200, "Title\n\n[00:00] Participant: Some words");
    expect(await client.transcripts.getText("transcript/1")).toBe("Title\n\n[00:00] Participant: Some words");
    await expectRequest("GET", `${transcriptPath}/text`);
  });

  it("keeps the API error when the text operation fails", async () => {
    const { client } = exampleServer(409, { error: { code: "transcript.not_ready" } });
    await expect(client.transcripts.getText("transcript/1")).rejects.toMatchObject({ name: "ChalkAPIError", status: 409, code: "transcript.not_ready", requestId: "request-1" });
  });

  it("creates a download URL with its requested expiry", async () => {
    const { client, expectRequest } = exampleServer(200, { url: "https://download.test/document" });
    expect((await client.transcripts.createDownloadURL("transcript/1", { expiresInSeconds: 60 })).url).toBe("https://download.test/document");
    await expectRequest("POST", `${transcriptPath}/download-url`, { expires_in_seconds: 60 });
  });

  it("requests on-demand transcription with a body idempotency key", async () => {
    const { client, expectRequest } = exampleServer(202, { job_id: "job-1" });
    expect((await client.transcripts.request("recording/1", { idempotencyKey: "transcript-request-1", languages: ["en", "es"] })).job_id).toBe("job-1");
    const request = await expectRequest("POST", `${tenantPath}/recordings/recording%2F1/transcripts`, { idempotency_key: "transcript-request-1", languages: ["en", "es"] });
    expect(request.headers.has("Idempotency-Key")).toBe(false);
  });

  it("deletes without decoding the empty response", async () => {
    const { client, expectRequest } = exampleServer(204);
    expect(await client.transcripts.delete("transcript/1")).toBeUndefined();
    await expectRequest("DELETE", transcriptPath);
  });
});

describe("Webhook endpoints", () => {
  const idempotency = { idempotencyKey: "webhook-request-1" };
  const keyHeader = { "Idempotency-Key": idempotency.idempotencyKey };

  it("creates an endpoint and returns its one-time secret", async () => {
    const { client, expectRequest } = exampleServer(201, { secret: "one-time-secret" });
    const result = await client.webhookEndpoints.create({ apiVersion: 1, enabled: true, eventTypes: ["episode.ended"], name: "Events", url: "https://hooks.test/events" }, idempotency);
    expect(result.secret).toBe("one-time-secret");
    await expectRequest("POST", `${tenantPath}/webhook-endpoints`, { api_version: 1, enabled: true, event_types: ["episode.ended"], name: "Events", url: "https://hooks.test/events" }, keyHeader);
  });

  it("lists endpoints with pagination", async () => {
    const { client, expectRequest } = exampleServer(200, { webhook_endpoints: [] });
    expect((await client.webhookEndpoints.list({ cursor: "next", pageSize: 5 })).webhook_endpoints).toEqual([]);
    await expectRequest("GET", `${tenantPath}/webhook-endpoints?cursor=next&page_size=5`);
  });

  it("gets an endpoint", async () => {
    const { client, expectRequest } = exampleServer(200, { revision: 3 });
    expect((await client.webhookEndpoints.get("endpoint/1")).revision).toBe(3);
    await expectRequest("GET", webhookPath);
  });

  it("updates with a quoted revision and only supplied fields", async () => {
    const { client, expectRequest } = exampleServer(200, { revision: 4 });
    expect((await client.webhookEndpoints.update("endpoint/1", { revision: 3, enabled: false }, idempotency)).revision).toBe(4);
    await expectRequest("PATCH", webhookPath, { enabled: false }, { ...keyHeader, "If-Match": '"3"' });
  });

  it("rotates the secret and generates an idempotency key when omitted", async () => {
    const { client, expectRequest } = exampleServer(200, { secret: "rotated-secret" });
    expect((await client.webhookEndpoints.rotateSecret("endpoint/1", { revokePreviousImmediately: false })).secret).toBe("rotated-secret");
    const request = await expectRequest("POST", `${webhookPath}/rotate-secret`, { revoke_previous_immediately: false });
    expect(request.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("deletes with a quoted revision and handles the empty response", async () => {
    const { client, expectRequest } = exampleServer(204);
    expect(await client.webhookEndpoints.delete("endpoint/1", 3, idempotency)).toBeUndefined();
    await expectRequest("DELETE", webhookPath, undefined, { ...keyHeader, "If-Match": '"3"' });
  });

  it("lists deliveries with repeated filters", async () => {
    const { client, expectRequest } = exampleServer(200, { deliveries: [] });
    const result = await client.webhookEndpoints.listDeliveries("endpoint/1", { cursor: "next", pageSize: 5, states: ["pending", "retry_wait"], eventTypes: ["episode.ended", "endpoint.test"] });
    expect(result.deliveries).toEqual([]);
    await expectRequest("GET", `${webhookPath}/deliveries?cursor=next&page_size=5&state=pending&state=retry_wait&event_type=episode.ended&event_type=endpoint.test`);
  });

  it("redelivers with the requested idempotency key", async () => {
    const { client, expectRequest } = exampleServer(201, { delivery_id: "next-delivery" });
    expect((await client.webhookEndpoints.redeliver("endpoint/1", "delivery/1", idempotency)).delivery_id).toBe("next-delivery");
    await expectRequest("POST", `${webhookPath}/deliveries/delivery%2F1/redeliver`, undefined, keyHeader);
  });
});
