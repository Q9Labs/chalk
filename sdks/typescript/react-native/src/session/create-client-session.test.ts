import { describe, expect, it, vi } from "vitest";

import { createClientSession } from "./create-client-session";

const clientSessionId = "c".repeat(43);
const inviteToken = "i".repeat(43);

describe("createClientSession", () => {
  it("creates a client session and supplies contextual participant access", async () => {
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
      .mockResolvedValueOnce(json(participantAccess()));
    const session = await createClientSession({
      brokerBaseURL: "https://chalkmeet.com/local-chalk/",
      displayName: "Ada",
      fetch,
      telemetry: telemetry(),
    });

    expect(session.meetingLink).toBe(`https://chalkmeet.com/#meeting=${inviteToken}`);
    await session.access({
      reason: "media_recovery",
      replaceMediaConnection: true,
      currentMediaToken: mediaToken("old"),
    });

    expect(request(fetch, 0)).toMatchObject({
      url: "https://chalkmeet.com/local-chalk/client-session",
      body: { displayName: "Ada" },
    });
    expect(request(fetch, 1)).toMatchObject({
      url: "https://chalkmeet.com/local-chalk/participant-access",
      body: { clientSessionId, currentMediaToken: mediaToken("old"), inviteToken, replaceMediaConnection: true },
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

    const session = await createClientSession({
      brokerBaseURL: "https://chalkmeet.com/local-chalk",
      credential: { clientSessionId, inviteToken },
      displayName: "Ada",
      fetch,
    });
    await session.cleanup();

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
      tenantId: "tenant",
      roomId: "room",
      sessionId: "session",
      participantSessionId: "participant",
      participantGeneration: 1,
    },
    sync: { token: syncToken("sync"), expiresAt: "2026-07-30T18:00:00.000Z" },
    media: {
      token: mediaToken("media"),
      expiresAt: "2026-07-30T18:00:00.000Z",
      provider: "cloudflare_sfu",
      clientPayload: { connectionId: "connection", stunServer: "stun:stun.cloudflare.com:3478" },
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
