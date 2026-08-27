import { describe, expect, it } from "vitest";

import { createChalkPublicClient } from "./client";

describe("public Space invite media recovery", () => {
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
