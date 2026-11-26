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

describe("recordings.delete", () => {
  it("deletes the tenant recording path", async () => {
    let request: { method?: string; url?: string } = {};
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = { method: init?.method, url: String(input) };
      return new Response(null, { status: 204 });
    };
    const client = createChalkServerClient({ apiKey: "key", tenantId: "tenant-1", apiBaseURL: "https://api.test", fetch });

    await client.recordings.delete("recording-1");

    expect(request).toEqual({ method: "DELETE", url: "https://api.test/v1/tenants/tenant-1/recordings/recording-1" });
  });
});
