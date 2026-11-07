import { describe, expect, it } from "vitest";

import { ArrivalUnavailableError, SpacePublicInviteUnavailableError } from "./index";
import { createChalkPublicClient } from "./client";
import type { ChalkPublicClient } from "./types";

describe("public Space invite media recovery", () => {
  it("prepares an Entrance with the invite capability without creating participant access", async () => {
    const requests: string[] = [];
    let requestBody: unknown;
    const client = createChalkPublicClient({
      baseUrl: "https://api.chalk.test",
      fetch: async (input, init) => {
        requests.push(String(input));
        requestBody = await new Response(init?.body).json();
        return Response.json({ prepared: true });
      },
    });
    await client.prepareSpaceEntrance("valid-invite");
    expect(requests).toEqual(["https://api.chalk.test/v1/public/space-invite-entrance"]);
    expect(requestBody).toEqual({ space_invite_token: "valid-invite" });
  });
  it.each(["space_public_invite.unavailable", "arrival.unavailable"])("preserves the observed %s contract error through the Promise boundary", async (code) => {
    const client = createChalkPublicClient({
      baseUrl: "https://api.chalk.test",
      fetch: async () => Response.json({ error: { code, message: "Public Space invite is unavailable" } }, { status: 404 }),
    });
    const cause = await client.arriveBySpacePublicInvite({ spaceInviteToken: "unavailable-fixture", displayName: "Ada" }).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(code === "space_public_invite.unavailable" ? SpacePublicInviteUnavailableError : ArrivalUnavailableError);
    expect(cause).toMatchObject({ error: { code, message: "Public Space invite is unavailable" } });
  });
  it("forwards a requested media connection replacement", async () => {
    let requestBody: unknown;
    const client = createChalkPublicClient({
      baseUrl: "https://api.chalk.test",
      fetch: async (_input, init) => {
        requestBody = await new Response(init?.body).json();
        return Response.json(accessGrant(), { status: 201 });
      },
    });

    await client.refreshSpacePublicInviteAccess({ arrivalHandle: "55555555-5555-4555-8555-555555555555", mediaProof: "media-proof", replaceMediaConnection: true });

    expect(requestBody).toEqual({ media_proof: "media-proof", replace_media_connection: true });
  });
  it.each([
    ["creates a Space", (client: ChalkPublicClient) => client.createPublicSpace({ displayName: "Ada" })],
    ["arrives", (client: ChalkPublicClient) => client.arriveBySpacePublicInvite({ spaceInviteToken: "valid-invite", displayName: "Ada" })],
    ["polls status", (client: ChalkPublicClient) => client.getSpacePublicInviteArrival({ arrivalHandle: "55555555-5555-4555-8555-555555555555" })],
    ["refreshes access", (client: ChalkPublicClient) => client.refreshSpacePublicInviteAccess({ arrivalHandle: "55555555-5555-4555-8555-555555555555", mediaProof: "media-proof" })],
  ])("declares both media providers when it %s", async (_name, call) => {
    const declared: (string | null)[] = [];
    const client = createChalkPublicClient({
      baseUrl: "https://api.chalk.test",
      fetch: async (input, init) => {
        declared.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-chalk-media-providers"));
        return Response.json({}, { status: 500 });
      },
    });

    await call(client).catch(() => undefined);

    expect(declared).toEqual(["cloudflare_sfu,chalk_sfu"]);
  });
});

function accessGrant() {
  return {
    subject: {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      space_id: "22222222-2222-4222-8222-222222222222",
      episode_id: "33333333-3333-4333-8333-333333333333",
      participant_id: "44444444-4444-4444-8444-444444444444",
      participant_generation: 1,
    },
    sync: { token: accessToken("chalk-sync"), expires_at: "2026-08-24T00:00:00Z" },
    media: {
      token: accessToken("chalk-media"),
      expires_at: "2026-08-24T00:00:00Z",
      provider: "cloudflare_sfu",
      client_payload: { connectionId: "connection", stunServer: "stun:example.test" },
    },
  };
}

function accessToken(audience: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
}
