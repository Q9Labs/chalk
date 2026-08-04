import { describe, expect, it, vi } from "vitest";

import { connectionAccessFor, createClientSession } from "./create-client-session";

const clientSessionId = "c".repeat(43);
const inviteToken = "i".repeat(43);

describe("createClientSession", () => {
  it("keeps public access contextual while media recovery replaces its connection", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          apiBaseURL: "https://api.chalkmeet.com",
          clientSessionId,
          inviteToken,
          syncURL: "wss://sync.chalkmeet.com/v1/sync",
        }),
      )
      .mockResolvedValueOnce(json(participantAccess()))
      .mockResolvedValueOnce(json(participantAccess()))
      .mockResolvedValueOnce(json(participantAccess()));
    const client = await createClientSession({
      brokerBaseURL: "https://chalkmeet.com/local-chalk/",
      displayName: "Ada",
      fetch,
      telemetry: telemetry(),
    });

    expect(client.meetingLink).toBe(`https://chalkmeet.com/#meeting=${inviteToken}`);
    await client.access({ space: "design-review", reason: "retry" });
    const connectionAccess = connectionAccessFor(client.access);
    expect(connectionAccess).toBeTypeOf("function");
    await connectionAccess?.({ reason: "media_recovery", replaceMediaConnection: true });
    await connectionAccess?.({ reason: "access_retry", replaceMediaConnection: false, currentMediaToken: mediaToken("current") as never });

    expect(request(fetch, 0)).toMatchObject({
      url: "https://chalkmeet.com/local-chalk/client-session",
      body: { displayName: "Ada" },
    });
    expect(request(fetch, 1)).toMatchObject({
      url: "https://chalkmeet.com/local-chalk/participant-access",
      body: { clientSessionId, inviteToken, replaceMediaConnection: false },
    });
    expect(request(fetch, 2)).toMatchObject({
      url: "https://chalkmeet.com/local-chalk/participant-access",
      body: { clientSessionId, inviteToken, replaceMediaConnection: true },
    });
    expect(request(fetch, 3)).toMatchObject({
      url: "https://chalkmeet.com/local-chalk/participant-access",
      body: { clientSessionId, currentMediaToken: mediaToken("current"), inviteToken, replaceMediaConnection: false },
    });
    expect((fetch.mock.calls[0]?.[1]?.headers as Headers).get("x-chalk-journey-id")).toBe("journey-1");
  });

  it("resumes a client session and cleans it up with the same opaque credential", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          apiBaseURL: "https://api.chalkmeet.com",
          clientSessionId,
          inviteToken,
          syncURL: "wss://sync.chalkmeet.com/v1/sync",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = await createClientSession({
      brokerBaseURL: "https://chalkmeet.com/local-chalk",
      credential: { clientSessionId, inviteToken },
      displayName: "Ada",
      fetch,
    });
    await client.cleanup();

    expect(request(fetch, 0).body).toEqual({ clientSessionId, displayName: "Ada", inviteToken });
    expect(request(fetch, 1)).toMatchObject({
      url: "https://chalkmeet.com/local-chalk/client-session/cleanup",
      body: { clientSessionId, inviteToken },
    });
  });

  it("rejects invalid broker responses and preserves public broker errors", async () => {
    await expect(
      createClientSession({
        brokerBaseURL: "https://chalkmeet.com/local-chalk",
        displayName: "Ada",
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ inviteToken })),
      }),
    ).rejects.toThrow("invalid client session");

    await expect(
      createClientSession({
        brokerBaseURL: "https://chalkmeet.com/local-chalk",
        displayName: "Ada",
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: "Meeting is full" }, 409)),
      }),
    ).rejects.toThrow("Meeting is full");
  });
});

function request(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index: number) {
  const [url, init] = fetch.mock.calls[index] ?? [];
  return {
    url,
    body: JSON.parse(String(init?.body)) as unknown,
  };
}

function json(body: unknown, status = 201): Response {
  return Response.json(body, { status });
}

function participantAccess() {
  return {
    subject: {
      tenant_id: "tenant",
      space_id: "space",
      episode_id: "episode",
      participant_id: "participant",
      participant_generation: 1,
    },
    sync: { token: syncToken("sync"), expires_at: "2026-07-30T18:00:00.000Z" },
    media: {
      token: mediaToken("media"),
      expires_at: "2026-07-30T18:00:00.000Z",
      provider: "cloudflare_sfu",
      client_payload: { connectionId: "connection", stunServer: "stun:stun.cloudflare.com:3478" },
    },
  };
}

function syncToken(suffix: string) {
  return token("chalk-sync", suffix);
}

function mediaToken(suffix: string) {
  return token("chalk-media", suffix);
}

function token(audience: string, suffix: string) {
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.${suffix}`;
}

function encode(value: unknown) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function telemetry() {
  return {
    context: { journeyId: "journey-1", rootJourneyId: "journey-1", traceId: "trace-1" },
    headers: { "x-chalk-journey-id": "journey-1" },
    recordDiagnostic: vi.fn(),
    recordRtcSummary: vi.fn(),
    recordSyncFrame: vi.fn(),
  };
}
