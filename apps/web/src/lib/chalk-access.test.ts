import type { ChalkSessionAccessRequest, ParticipantAccess } from "@q9labsai/chalk-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { beaconLocalBrowserSessionCleanup, cleanupLocalBrowserSession, createLocalAccessProvider, createLocalBrowserSession } from "./chalk-access";

const access = {
  subject: {
    tenantId: "tenant-1",
    roomId: "room-1",
    sessionId: "session-1",
    participantSessionId: "participant-1",
    participantGeneration: 3,
  },
  sync: { token: "sync-token", expiresAt: "2026-07-21T14:30:00Z" },
  media: {
    token: "media-token",
    expiresAt: "2026-07-21T14:30:00Z",
    provider: "cloudflare_sfu",
    clientPayload: { connectionId: "connection-1", stunServer: "stun:example.test" },
  },
} as unknown as ParticipantAccess;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local Chalk access client", () => {
  it("creates only the opaque browser session with same-origin credentials", async () => {
    const fetchMock = stubFetch(jsonResponse({ apiBaseURL: "http://127.0.0.1:8080", syncURL: "ws://127.0.0.1:4100/v3/sync" }, 201));

    await expect(createLocalBrowserSession("Ada")).resolves.toEqual({ apiBaseURL: "http://127.0.0.1:8080", syncURL: "ws://127.0.0.1:4100/v3/sync" });
    expectRequest(fetchMock, "/local-chalk/browser-session", { displayName: "Ada" });
  });

  it("does not request participant access until the SDK invokes the provider", async () => {
    const fetchMock = stubFetch(jsonResponse(access, 201));

    const provider = createLocalAccessProvider();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(provider()).resolves.toEqual(access);
    expectRequest(fetchMock, "/local-chalk/access", { replaceMediaConnection: false });
  });

  it("forwards only media refresh inputs and leaves identity on the backend", async () => {
    const fetchMock = stubFetch(jsonResponse(access, 201));
    const provider = createLocalAccessProvider();
    const request = {
      reason: "media_recovery",
      replaceMediaConnection: true,
      currentMediaToken: "opaque-current-media-token",
      expectedParticipantGeneration: 999,
    } as unknown as ChalkSessionAccessRequest;

    await provider(request);

    expectRequest(fetchMock, "/local-chalk/access", {
      currentMediaToken: "opaque-current-media-token",
      replaceMediaConnection: true,
    });
    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty("expectedParticipantGeneration");
    expect(body).not.toHaveProperty("participantSessionId");
  });

  it("clears the server-held browser session and surfaces backend errors", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await expect(cleanupLocalBrowserSession()).resolves.toBeUndefined();
    expectRequest(fetchMock, "/local-chalk/cleanup", {});

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "The local browser session is missing or expired." }, 401));
    await expect(cleanupLocalBrowserSession()).rejects.toThrow("The local browser session is missing or expired.");
  });

  it("uses a same-origin beacon for page-unload cleanup when available", () => {
    const sendBeacon = vi.fn<(url: string | URL, data?: BodyInit | null) => boolean>(() => true);
    vi.stubGlobal("navigator", { sendBeacon });

    beaconLocalBrowserSessionCleanup();

    expect(sendBeacon).toHaveBeenCalledOnce();
    const [url, body] = sendBeacon.mock.calls[0]!;
    expect(url).toBe("/local-chalk/cleanup");
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).type).toBe("application/json");
  });
});

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function expectRequest(fetchMock: ReturnType<typeof stubFetch>, path: string, body: unknown): void {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe(path);
  expect(init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
  expect(JSON.parse(String(init?.body))).toEqual(body);
}

function requestBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] ?? [];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}
