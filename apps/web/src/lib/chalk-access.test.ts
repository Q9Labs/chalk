import type { AccessGrant, GetAccess } from "@q9labsai/chalk-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupParticipantCredential, createAccessGrantProvider, createParticipantCredential, joinDashboardSpace } from "./chalk-access";

const participantCredential = {
  apiBaseURL: "https://api.chalk.test",
  syncURL: "wss://sync.chalk.test/v1/sync",
};

const access = {
  subject: {
    tenant_id: "tenant-1",
    space_id: "space-1",
    episode_id: "episode-1",
    participant_id: "participant-1",
    participant_generation: 3,
  },
  sync: { token: credential("chalk-sync"), expires_at: "2026-07-21T14:30:00Z" },
  media: {
    token: credential("chalk-media"),
    expires_at: "2026-07-21T14:30:00Z",
    provider: "cloudflare_sfu",
    client_payload: { connectionId: "connection-1", stunServer: "stun:example.test" },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local Chalk access client", () => {
  it("creates an opaque participant credential with same-origin credentials", async () => {
    const { requests } = stubFetch(jsonResponse(participantCredential, 201));

    await expect(createParticipantCredential("Ada")).resolves.toEqual(participantCredential);
    expectRequest(requests, "/local-chalk/participant-credentials", { displayName: "Ada" });
  });

  it("forwards the Space invite token to the same-origin broker", async () => {
    vi.stubGlobal("location", { hostname: "chalkmeet.com" });
    const { requests } = stubFetch(jsonResponse({ ...participantCredential, spaceInviteToken: "i".repeat(43) }, 201));

    await expect(createParticipantCredential("Grace", "i".repeat(43))).resolves.toMatchObject({ spaceInviteToken: "i".repeat(43) });

    expectRequest(requests, "/local-chalk/participant-credentials", { displayName: "Grace", spaceInviteToken: "i".repeat(43) });
  });

  it("forwards the Space invite token through the local broker proxy", async () => {
    vi.stubGlobal("location", { hostname: "127.0.0.1" });
    const { requests } = stubFetch(jsonResponse({ ...participantCredential, spaceInviteToken: "i".repeat(43) }, 201));

    await expect(createParticipantCredential("Ada", "i".repeat(43))).resolves.toMatchObject({ spaceInviteToken: "i".repeat(43) });

    expectRequest(requests, "/local-chalk/participant-credentials", { displayName: "Ada", spaceInviteToken: "i".repeat(43) });
  });

  it("validates and preserves the broker-selected API and Sync endpoints", async () => {
    const credential = { apiBaseURL: "https://api.chalk.test/control", syncURL: "wss://sync.chalk.test/v1/sync?space=local" };
    stubFetch(jsonResponse(credential, 201));

    await expect(createParticipantCredential("Ada")).resolves.toEqual(credential);
  });

  it.each([
    [{ apiBaseURL: "not a URL", syncURL: participantCredential.syncURL }, "API"],
    [{ apiBaseURL: "https://user:password@api.chalk.test", syncURL: participantCredential.syncURL }, "API"],
    [{ apiBaseURL: participantCredential.apiBaseURL, syncURL: "https://sync.chalk.test/v1/sync" }, "Sync"],
    [{ apiBaseURL: participantCredential.apiBaseURL, syncURL: "wss://user:password@sync.chalk.test/v1/sync" }, "Sync"],
  ])("rejects an invalid broker-selected %s endpoint", async (body, label) => {
    stubFetch(jsonResponse(body, 201));

    await expect(createParticipantCredential("Ada")).rejects.toThrow(`invalid ${label} URL`);
  });

  it("does not request an access grant until the client invokes getAccess", async () => {
    const { requests } = stubFetch(jsonResponse(access, 201));

    const provider = createAccessGrantProvider();
    expect(requests).toEqual([]);
    const grant: AccessGrant = await provider({ space: "local-space", reason: "join" });
    expect(grant).toEqual(access);
    expectRequest(requests, "/local-chalk/access-grants", {});
  });

  it("keeps public access context and the opaque grant at the client boundary", async () => {
    const { requests } = stubFetch(jsonResponse(access, 201));
    const provider = createAccessGrantProvider();
    const context = { space: "local-space", reason: "refresh" } satisfies Parameters<GetAccess>[0];

    await provider(context);

    expectRequest(requests, "/local-chalk/access-grants", {});
  });

  it("propagates the page journey through the broker access boundary", async () => {
    const { requests } = stubFetch(jsonResponse(access, 201));
    const recordHttpRequest = vi.fn();
    const journey = {
      headers: { "x-chalk-journey-id": "journey-1", traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
      recordHttpRequest,
    };

    await createAccessGrantProvider(journey)({ space: "local-space", reason: "join" });

    const [, init] = requests[0] ?? [];
    expect(init?.headers).toMatchObject(journey.headers);
    expect(recordHttpRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", route: "/local-chalk/access-grants", statusCode: 201, state: "succeeded" }));
  });

  it("cleans up the server-held participant credential and surfaces broker errors", async () => {
    const { fetchMock, requests } = stubFetch(new Response(null, { status: 204 }));
    await expect(cleanupParticipantCredential()).resolves.toBeUndefined();
    expectRequest(requests, "/local-chalk/participant-credentials/cleanup", {});

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "The local participant credential is missing or expired." }, 401));
    await expect(cleanupParticipantCredential()).rejects.toThrow("The local participant credential is missing or expired.");
  });

  it("keeps cleanup alive while the page unloads", async () => {
    const { requests } = stubFetch(new Response(null, { status: 204 }));

    await cleanupParticipantCredential(undefined, { keepalive: true });

    const [, init] = requests[0] ?? [];
    expect(init).toMatchObject({ keepalive: true });
  });

  it("joins, refreshes, and leaves a Dashboard Space through the account boundary", async () => {
    vi.stubGlobal("location", { origin: "https://chalkmeet.com" });
    const requests: Array<Parameters<typeof fetch>> = [];
    const responses = [jsonResponse({ csrf_token: "csrf-1" }, 200), jsonResponse(access, 201), jsonResponse({ csrf_token: "csrf-2" }, 200), jsonResponse(access, 201), jsonResponse({ csrf_token: "csrf-3" }, 200), new Response(null, { status: 204 })];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (...input) => {
        requests.push(input);
        return responses.shift() ?? new Response(null, { status: 500 });
      }),
    );

    const spaceAccess = await joinDashboardSpace("tenant-1", "design-lab", "Ada");
    await expect(spaceAccess.connectionAccess({ reason: "join", replaceMediaConnection: false })).resolves.toEqual(access);
    await expect(spaceAccess.connectionAccess({ reason: "scheduled_refresh", replaceMediaConnection: false, currentMediaToken: access.media.token as never, expectedParticipantGeneration: 3 })).resolves.toEqual(access);
    await expect(spaceAccess.leave({ keepalive: true })).resolves.toBeUndefined();

    expect(requests.map(([url]) => url)).toEqual([
      "/api/auth/csrf",
      "/api/tenants/tenant-1/spaces/by-slug/design-lab/participants/self",
      "/api/auth/csrf",
      "/api/tenants/tenant-1/spaces/by-slug/design-lab/participants/self/access-grants",
      "/api/auth/csrf",
      "/api/tenants/tenant-1/spaces/by-slug/design-lab/participants/self",
    ]);
    expect(JSON.parse(String(requests[1]?.[1]?.body))).toEqual({ display_name: "Ada" });
    expect(JSON.parse(String(requests[3]?.[1]?.body))).toEqual({ current_media_token: access.media.token, participant_generation: 3, replace_media_connection: false });
    expect(requests[5]?.[1]).toMatchObject({ method: "DELETE", keepalive: true });
    expect(JSON.parse(String(requests[5]?.[1]?.body))).toEqual({ participant_generation: 3 });
  });

  it("uses stored media proof when the public Dashboard provider refreshes access", async () => {
    const requests: Array<Parameters<typeof fetch>> = [];
    const responses = [jsonResponse({ csrf_token: "csrf-1" }, 200), jsonResponse(access, 201), jsonResponse({ csrf_token: "csrf-2" }, 200), jsonResponse(access, 201), jsonResponse({ csrf_token: "csrf-3" }, 200), jsonResponse(access, 201)];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (...input) => {
        requests.push(input);
        return responses.shift() ?? new Response(null, { status: 500 });
      }),
    );

    const spaceAccess = await joinDashboardSpace("tenant-1", "design-lab", "Ada");
    await spaceAccess.connectionAccess({ reason: "join", replaceMediaConnection: false });
    await expect(spaceAccess.getAccess({ space: "design-lab", reason: "refresh" })).resolves.toEqual(access);
    await expect(spaceAccess.getAccess({ space: "design-lab", reason: "retry" })).resolves.toEqual(access);

    expect(JSON.parse(String(requests[3]?.[1]?.body))).toEqual({ current_media_token: access.media.token, participant_generation: 3, replace_media_connection: false });
    expect(JSON.parse(String(requests[5]?.[1]?.body))).toEqual({ participant_generation: 3, replace_media_connection: true });
  });
});

function credential(audience: "chalk-sync" | "chalk-media"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
}

function stubFetch(response: Response) {
  const requests: Array<Parameters<typeof fetch>> = [];
  const fetchMock = vi.fn<typeof fetch>(async (...input) => {
    requests.push(input);
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function expectRequest(requests: readonly Parameters<typeof fetch>[], path: string, body: unknown): void {
  expect(requests).toHaveLength(1);
  const [url, init] = requests[0] ?? [];
  expect(url).toBe(path);
  expect(init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
  expect(JSON.parse(String(init?.body))).toEqual(body);
}
