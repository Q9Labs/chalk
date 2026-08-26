import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccessGrant } from "../../../../sdks/typescript/client/src/access/grant";

const sdk = vi.hoisted(() => ({ createChalkPublicClient: vi.fn() }));
vi.mock("@q9labsai/chalk-client", async () => {
  const actual = await vi.importActual<typeof import("@q9labsai/chalk-client")>("@q9labsai/chalk-client");
  return { ...actual, createChalkPublicClient: sdk.createChalkPublicClient };
});

import { createPreparedPublicSpace, createPublicInviteClient, joinDashboardSpace, publicAPIBaseURL, publicSyncURL, type PublicInviteClient } from "./chalk-access";

function accessToken(audience: string, suffix: string): string {
  return `${btoa("header")}.${btoa(JSON.stringify({ aud: audience }))}.${suffix}`;
}

function accessWire(mediaSuffix = "media-token") {
  return {
    subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 3 },
    sync: { token: accessToken("chalk-sync", "sync-token"), expires_at: "2026-08-20T00:00:00Z" },
    media: {
      token: accessToken("chalk-media", mediaSuffix),
      expires_at: "2026-08-20T00:00:00Z",
      provider: "cloudflare_sfu",
      client_payload: { connectionId: "connection-1", stunServer: "stun:example.test" },
    },
  };
}

const accessWireValue = accessWire();
const access = parseAccessGrant(accessWireValue);

type PublicSDKMock = {
  readonly createPublicSpace: ReturnType<typeof vi.fn>;
  readonly arriveBySpacePublicInvite: ReturnType<typeof vi.fn>;
  readonly getSpacePublicInviteArrival: ReturnType<typeof vi.fn>;
  readonly refreshSpacePublicInviteAccess: ReturnType<typeof vi.fn>;
  readonly leaveSpacePublicInviteArrival: ReturnType<typeof vi.fn>;
};

function sdkClient(): PublicSDKMock {
  return {
    createPublicSpace: vi.fn(),
    arriveBySpacePublicInvite: vi.fn(),
    getSpacePublicInviteArrival: vi.fn(),
    refreshSpacePublicInviteAccess: vi.fn(),
    leaveSpacePublicInviteArrival: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://api.chalk.test");
  sdk.createChalkPublicClient.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public Chalk access adapter", () => {
  it("configures the browser SDK with the API origin and journey headers", () => {
    const client = sdkClient();
    sdk.createChalkPublicClient.mockReturnValue(client);

    createPublicInviteClient({
      headers: { traceparent: "00-trace" },
      context: { journeyId: "journey-1", rootJourneyId: "journey-1", traceparent: "00-trace" },
    });

    expect(sdk.createChalkPublicClient).toHaveBeenCalledWith({
      baseUrl: "https://api.chalk.test",
      credentials: "include",
      headers: { traceparent: "00-trace" },
      telemetry: { journeyId: "journey-1", rootJourneyId: "journey-1", traceparent: "00-trace" },
    });
  });

  it("maps create and invite arrival operations to capability-first inputs", async () => {
    const client = sdkClient();
    const created = { invite_link: "https://app.chalk.test/space/design-lab#spaceInviteToken=cspi1.created", arrival: { state: "admitted" } };
    const arrived = { state: "pending", arrival_handle: "arrival-1" };
    client.createPublicSpace.mockResolvedValue(created);
    client.arriveBySpacePublicInvite.mockResolvedValue(arrived);
    sdk.createChalkPublicClient.mockReturnValue(client);
    const adapter = createPublicInviteClient();

    await expect(adapter.createPublicSpace("Ada")).resolves.toBe(created);
    await expect(adapter.arriveBySpacePublicInvite("cspi1.invite", "Grace")).resolves.toBe(arrived);

    expect(client.createPublicSpace).toHaveBeenCalledWith({ displayName: "Ada" }, { idempotencyKey: expect.any(String) });
    expect(client.arriveBySpacePublicInvite).toHaveBeenCalledWith({ spaceInviteToken: "cspi1.invite", displayName: "Grace" }, { idempotencyKey: expect.any(String) });
  });

  it("keeps arrival status, refresh, and leave on the public invite client", async () => {
    const client = sdkClient();
    const arrival = { state: "admitted", arrival_handle: "arrival-1" };
    const refreshed = parseAccessGrant(accessWire());
    client.getSpacePublicInviteArrival.mockResolvedValue(arrival);
    client.refreshSpacePublicInviteAccess.mockResolvedValue(refreshed);
    client.leaveSpacePublicInviteArrival.mockResolvedValue(undefined);
    sdk.createChalkPublicClient.mockReturnValue(client);
    const adapter = createPublicInviteClient();

    await expect(adapter.getSpacePublicInviteArrival("arrival-1")).resolves.toBe(arrival);
    await expect(adapter.refreshSpacePublicInviteAccess("arrival-1", "media-proof")).resolves.toBe(refreshed);
    await expect(adapter.refreshSpacePublicInviteAccess("arrival-1", "media-proof", true)).resolves.toBe(refreshed);
    await expect(adapter.leaveSpacePublicInviteArrival("arrival-1", { keepalive: true })).resolves.toBeUndefined();

    expect(client.getSpacePublicInviteArrival).toHaveBeenCalledWith({ arrivalHandle: "arrival-1" });
    expect(client.refreshSpacePublicInviteAccess).toHaveBeenCalledWith({ arrivalHandle: "arrival-1", mediaProof: "media-proof" });
    expect(client.refreshSpacePublicInviteAccess).toHaveBeenCalledWith({ arrivalHandle: "arrival-1", mediaProof: "media-proof", replaceMediaConnection: true });
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenCalledWith("arrival-1", { keepalive: true });
  });

  it("maps a resumed arrival to the typed arrival operation", async () => {
    const client = sdkClient();
    const resumed = { state: "admitted", arrival_handle: "arrival-1", access };
    client.arriveBySpacePublicInvite.mockResolvedValue(resumed);
    sdk.createChalkPublicClient.mockReturnValue(client);
    const adapter = createPublicInviteClient();

    await expect(adapter.arriveBySpacePublicInvite("cspi1.invite", "Grace", { arrivalHandle: "arrival-1" })).resolves.toBe(resumed);

    expect(client.arriveBySpacePublicInvite).toHaveBeenCalledWith({ spaceInviteToken: "cspi1.invite", displayName: "Grace" }, { idempotencyKey: expect.any(String), arrivalHandle: "arrival-1" });
  });

  it("returns the first grant, refreshes media access, and leaves once", async () => {
    const refreshed = parseAccessGrant(accessWire("media-token-2"));
    const client: PublicInviteClient = {
      createPublicSpace: vi.fn(),
      arriveBySpacePublicInvite: vi.fn(),
      getSpacePublicInviteArrival: vi.fn(),
      refreshSpacePublicInviteAccess: vi.fn().mockResolvedValue(refreshed),
      leaveSpacePublicInviteArrival: vi.fn().mockResolvedValue(undefined),
    };
    const prepared = createPreparedPublicSpace(client, {
      state: "admitted",
      arrival_handle: "arrival-1",
      access,
      space: { admission_mode: "open", name: "Design Lab", slug: "design-lab" },
    });

    await expect(prepared.connectionAccess({ reason: "join", replaceMediaConnection: false })).resolves.toBe(access);
    await expect(prepared.connectionAccess({ reason: "media_recovery", replaceMediaConnection: true })).resolves.toBe(refreshed);
    await prepared.finish();
    await prepared.finish();

    expect(client.refreshSpacePublicInviteAccess).toHaveBeenCalledWith("arrival-1", accessToken("chalk-media", "media-token"), true);
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenCalledOnce();
  });

  it("releases the old public arrival and returns a fresh grant for explicit re-entry", async () => {
    const reenteredAccess = parseAccessGrant(accessWire("media-token-2"));
    const reenteredArrival = {
      state: "admitted",
      arrival_handle: "arrival-2",
      access: reenteredAccess,
      space: { admission_mode: "open", name: "Design Lab", slug: "design-lab" },
    } satisfies Awaited<ReturnType<PublicInviteClient["arriveBySpacePublicInvite"]>>;
    const client: PublicInviteClient = {
      createPublicSpace: vi.fn(),
      arriveBySpacePublicInvite: vi.fn(),
      getSpacePublicInviteArrival: vi.fn(),
      refreshSpacePublicInviteAccess: vi.fn(),
      leaveSpacePublicInviteArrival: vi.fn().mockResolvedValue(undefined),
    };
    const reenter = vi.fn().mockResolvedValue(reenteredArrival);
    const prepared = createPreparedPublicSpace(
      client,
      { state: "admitted", arrival_handle: "arrival-1", access, space: { admission_mode: "open", name: "Design Lab", slug: "design-lab" } },
      { reenter },
    );

    await expect(prepared.connectionAccess({ reason: "join", replaceMediaConnection: false })).resolves.toBe(access);
    await expect(prepared.connectionAccess({ reason: "join", replaceMediaConnection: false })).resolves.toBe(reenteredAccess);
    await prepared.finish();

    expect(reenter).toHaveBeenCalledOnce();
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenNthCalledWith(1, "arrival-1");
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenNthCalledWith(2, "arrival-2", {});
    expect(prepared.arrival).toBe(reenteredArrival);
  });

  it("does not release an old arrival twice when re-entry retries after a rejection", async () => {
    const reenteredAccess = parseAccessGrant(accessWire("media-token-2"));
    const reenteredArrival = {
      state: "admitted",
      arrival_handle: "arrival-2",
      access: reenteredAccess,
      space: { admission_mode: "open", name: "Design Lab", slug: "design-lab" },
    } satisfies Awaited<ReturnType<PublicInviteClient["arriveBySpacePublicInvite"]>>;
    const client: PublicInviteClient = {
      createPublicSpace: vi.fn(),
      arriveBySpacePublicInvite: vi.fn(),
      getSpacePublicInviteArrival: vi.fn(),
      refreshSpacePublicInviteAccess: vi.fn(),
      leaveSpacePublicInviteArrival: vi.fn().mockResolvedValue(undefined),
    };
    const reenter = vi
      .fn<() => Promise<typeof reenteredArrival>>()
      .mockRejectedValueOnce(new Error("re-entry unavailable"))
      .mockResolvedValueOnce(reenteredArrival);
    const prepared = createPreparedPublicSpace(
      client,
      { state: "admitted", arrival_handle: "arrival-1", access, space: { admission_mode: "open", name: "Design Lab", slug: "design-lab" } },
      { reenter },
    );

    await expect(prepared.connectionAccess({ reason: "join", replaceMediaConnection: false })).resolves.toBe(access);
    await expect(prepared.connectionAccess({ reason: "join", replaceMediaConnection: false })).rejects.toThrow("re-entry unavailable");
    await expect(prepared.connectionAccess({ reason: "join", replaceMediaConnection: false })).resolves.toBe(reenteredAccess);
    await prepared.finish();

    expect(reenter).toHaveBeenCalledTimes(2);
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenCalledTimes(2);
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenNthCalledWith(1, "arrival-1");
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenNthCalledWith(2, "arrival-2", {});
  });

  it("derives the sync endpoint from the API origin", () => {
    expect(publicAPIBaseURL()).toBe("https://api.chalk.test");
    expect(publicSyncURL("https://api.chalk.test/control")).toBe("wss://sync.chalk.test/v1/sync");
    expect(publicSyncURL("http://127.0.0.1:8080")).toBe("ws://127.0.0.1:8080/v1/sync");
  });

  it("keeps the explicit account join on the authenticated API path", async () => {
    const refreshed = accessWire("media-token-2");
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ csrf_token: "csrf-token" }))
      .mockResolvedValueOnce(Response.json(accessWireValue, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ canonical_url: "/space/design-lab#spaceInviteToken=cspi1.account" }))
      .mockResolvedValueOnce(Response.json(refreshed, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    const account = await joinDashboardSpace("tenant-1", "design-lab", "Ada", {
      headers: { traceparent: "00-trace" },
      context: { journeyId: "journey-1", rootJourneyId: "journey-1", traceparent: "00-trace" },
    });
    expect(account.inviteLink).toBe("/space/design-lab#spaceInviteToken=cspi1.account");
    expect(account.credential.space).toBe("space-1");
    await expect(account.getAccess({ space: "space-1", reason: "join" })).resolves.toEqual(accessWireValue);
    await expect(account.getAccess({ space: "space-1", reason: "refresh" })).resolves.toEqual(refreshed);
    await account.leave({ keepalive: true });

    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/tenants/tenant-1/spaces/by-slug/design-lab/participants/self", expect.objectContaining({ method: "POST" }));
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/tenants/tenant-1/spaces/space-1/public-invite", expect.objectContaining({ method: "GET" }));
    expect(fetcher).toHaveBeenNthCalledWith(4, "/api/tenants/tenant-1/spaces/by-slug/design-lab/participants/self/access-grants", expect.objectContaining({ method: "POST" }));
    expect(fetcher).toHaveBeenNthCalledWith(5, "/api/tenants/tenant-1/spaces/by-slug/design-lab/participants/self", expect.objectContaining({ method: "DELETE", keepalive: true }));
  });
});
