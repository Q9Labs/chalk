import type { AccessGrant, GetAccess } from "@q9labsai/chalk-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { beaconLocalBrowserSessionCleanup, cleanupLocalBrowserSession, createLocalAccessProvider, createLocalBrowserSession } from "./chalk-access";

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
  it("creates only the opaque browser session with same-origin credentials", async () => {
    const fetchMock = stubFetch(jsonResponse({ apiBaseURL: "http://127.0.0.1:8080", syncURL: "ws://127.0.0.1:4100/v1/sync" }, 201));

    await expect(createLocalBrowserSession("Ada")).resolves.toEqual({ apiBaseURL: "http://127.0.0.1:8080", syncURL: "ws://127.0.0.1:4100/v1/sync" });
    expectRequest(fetchMock, "/local-chalk/browser-session", { displayName: "Ada" });
  });

  it("forwards the URL-fragment invite to the production same-origin broker", async () => {
    vi.stubGlobal("location", { hostname: "chalkmeet.com" });
    const fetchMock = stubFetch(jsonResponse({ apiBaseURL: "https://api.chalkmeet.com", inviteToken: "i".repeat(43), syncURL: "wss://sync.chalkmeet.com/v1/sync" }, 201));

    await createLocalBrowserSession("Grace", "i".repeat(43));

    expectRequest(fetchMock, "/local-chalk/browser-session", { displayName: "Grace", inviteToken: "i".repeat(43) });
  });

  it("forwards the URL-fragment invite through the local Wrangler proxy", async () => {
    vi.stubGlobal("location", { hostname: "127.0.0.1" });
    const fetchMock = stubFetch(jsonResponse({ apiBaseURL: "http://127.0.0.1:8080", inviteToken: "i".repeat(43), syncURL: "ws://127.0.0.1:4100/v1/sync" }, 201));

    await createLocalBrowserSession("Ada", "i".repeat(43));

    expectRequest(fetchMock, "/local-chalk/browser-session", { displayName: "Ada", inviteToken: "i".repeat(43) });
  });

  it("does not request an access grant until the client invokes getAccess", async () => {
    const fetchMock = stubFetch(jsonResponse(access, 201));

    const provider = createLocalAccessProvider();
    expect(fetchMock).not.toHaveBeenCalled();
    const grant: AccessGrant = await provider({ space: "local-space", reason: "join" });
    expect(grant).toEqual(access);
    expectRequest(fetchMock, "/local-chalk/access", {});
  });

  it("keeps public access context and the opaque grant at the client boundary", async () => {
    const fetchMock = stubFetch(jsonResponse(access, 201));
    const provider = createLocalAccessProvider();
    const context = { space: "local-space", reason: "refresh" } satisfies Parameters<GetAccess>[0];

    await provider(context);

    expectRequest(fetchMock, "/local-chalk/access", {});
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

function credential(audience: "chalk-sync" | "chalk-media"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
}

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
