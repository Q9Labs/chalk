import { describe, expect, it } from "vitest";
import { createChalkPublicClient } from "./client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const participantId = "44444444-4444-4444-8444-444444444444";
const arrivalHandle = "55555555-5555-4555-8555-555555555555";

describe("public Space invite client", () => {
  it("creates and resumes browser arrivals with cookie credentials and exact headers", async () => {
    const { fetch, requests } = recordedFetch((input) => {
      if (String(input).endsWith("/public/spaces")) return jsonResponse(publicCreated(), 201);
      return jsonResponse({ state: "pending", arrival_handle: arrivalHandle, guest_credential: "guest-token" }, 201);
    });
    const client = createChalkPublicClient({ baseUrl: "https://api.chalk.test", fetch });

    await expect(client.createPublicSpace({ displayName: "Ada" }, { idempotencyKey: "create-public-key-0" })).resolves.toMatchObject({ invite_link: "https://chalk.test/space/invite" });
    await expect(client.arriveBySpacePublicInvite({ displayName: "Ada", spaceInviteToken: "invite-token" }, { idempotencyKey: "arrive-public-key-0" })).resolves.toMatchObject({ state: "pending", arrival_handle: arrivalHandle });

    const createRequest = requests[0];
    expect(String(createRequest?.input)).toBe("https://api.chalk.test/v1/public/spaces");
    expect(createRequest?.init?.credentials).toBe("include");
    expect(new Headers(createRequest?.init?.headers).get("idempotency-key")).toBe("create-public-key-0");
    await expect(requestBody(createRequest?.init)).resolves.toEqual({ display_name: "Ada" });

    const arrivalRequest = requests[1];
    expect(String(arrivalRequest?.input)).toBe("https://api.chalk.test/v1/public/space-invite-arrivals");
    expect(new Headers(arrivalRequest?.init?.headers).get("idempotency-key")).toBe("arrive-public-key-0");
    expect(new Headers(arrivalRequest?.init?.headers).get("x-chalk-arrival-handle")).toBeNull();
    expect(new Headers(arrivalRequest?.init?.headers).get("x-chalk-client")).toBeNull();
    await expect(requestBody(arrivalRequest?.init)).resolves.toEqual({ display_name: "Ada", space_invite_token: "invite-token" });
  });

  it("uses native Guest authorization for status, refresh, and leave", async () => {
    const { fetch, requests } = recordedFetch((input, init) => {
      if (String(input).endsWith("/access-grants")) return jsonResponse(accessGrant(), 201);
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
      if (String(input).endsWith("/v1/status")) return jsonResponse(status(), 200);
      return jsonResponse({ state: "admitted", arrival_handle: arrivalHandle }, 200);
    });
    const client = createChalkPublicClient({ baseUrl: "https://api.chalk.test", fetch, runtime: "react-native", guestCredential: "guest-token" });

    await expect(client.getPublicStatus()).resolves.toMatchObject({ overall: "ok" });
    await expect(client.getSpacePublicInviteArrival(arrivalHandle)).resolves.toMatchObject({ state: "admitted" });
    await expect(client.refreshSpacePublicInviteAccess("media-proof", { arrivalHandle })).resolves.toMatchObject({ subject: { participant_id: participantId } });
    await expect(client.leaveSpacePublicInviteArrival(arrivalHandle, { keepalive: true })).resolves.toBeUndefined();

    const statusRequest = requests[1];
    const statusHeaders = new Headers(statusRequest?.init?.headers);
    expect(statusHeaders.get("x-chalk-client")).toBe("react-native");
    expect(statusHeaders.get("authorization")).toBe("ChalkGuest guest-token");
    expect(statusHeaders.get("x-chalk-arrival-handle")).toBe(arrivalHandle);

    const refreshRequest = requests[2];
    await expect(requestBody(refreshRequest?.init)).resolves.toEqual({ media_proof: "media-proof" });
    expect(new Headers(refreshRequest?.init?.headers).get("idempotency-key")).toBeNull();

    const leaveRequest = requests[3];
    expect(leaveRequest?.init?.keepalive).toBe(true);
    expect(new Headers(leaveRequest?.init?.headers).get("authorization")).toBe("ChalkGuest guest-token");
  });

  it("passes keepalive to browser leave fetches", async () => {
    const { fetch, requests } = recordedFetch(() => {
      return new Response(null, { status: 204 });
    });
    const client = createChalkPublicClient({ baseUrl: "https://api.chalk.test", fetch });

    await expect(client.leaveSpacePublicInviteArrival(arrivalHandle, { keepalive: true })).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.keepalive).toBe(true);
  });
});

function publicCreated() {
  return {
    arrival: { state: "admitted", arrival_handle: arrivalHandle, guest_credential: "guest-token" },
    invite_link: "https://chalk.test/space/invite",
    lifecycle_until: "2026-08-20T00:00:00Z",
    space: { admission_mode: "open", name: "Ada", slug: "ada" },
  };
}

function status() {
  return { components: [], generated_at: "2026-08-19T00:00:00Z", overall: "ok", schema_version: 1 };
}

function accessGrant() {
  return {
    subject: { tenant_id: tenantId, space_id: spaceId, episode_id: episodeId, participant_id: participantId, participant_generation: 1 },
    sync: { token: accessToken("chalk-sync"), expires_at: "2026-08-20T00:00:00Z" },
    media: { token: accessToken("chalk-media"), expires_at: "2026-08-20T00:00:00Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection", stunServer: "stun:example.test" } },
  };
}

function accessToken(audience: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
}

function recordedFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>): { readonly fetch: typeof globalThis.fetch; readonly requests: readonly { readonly input: RequestInfo | URL; readonly init?: RequestInit }[] } {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return handler(input, init);
  };
  return { fetch, requests };
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

async function requestBody(init: RequestInit | undefined): Promise<unknown> {
  const body = init?.body;
  if (typeof body === "string") return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));
  if (body instanceof ReadableStream) return new Response(body).json();
  return body;
}
