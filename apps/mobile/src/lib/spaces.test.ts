import { afterEach, expect, it, vi } from "vitest";
import { createChalkPublicClient } from "@q9labsai/chalk-client/invites";
import { createGuestAccessGetter, parseSpaceLink } from "./spaces";

vi.mock("expo-secure-store", () => ({}));
afterEach(() => vi.unstubAllGlobals());

const credential = {
  arrivalHandle: "55555555-5555-4555-8555-555555555555",
  guestCredential: "guest-credential",
  slug: "media-recovery",
  spaceInviteToken: "invite-token",
};

it("uses an invite code as the route key when a short link has no slug", () => {
  expect(parseSpaceLink("https://chalkmeet.com/abc-defg-hij")).toEqual({
    kind: "space",
    space: "abc-defg-hij",
    spaceInviteToken: "abc-defg-hij",
    inviteLink: "https://chalkmeet.com/abc-defg-hij",
    source: "space-link",
  });
});

it.each(["refresh", "retry"] as const)("forwards replacement and cancellation during %s through the real public client", async (reason) => {
  const original = accessGrant("old-connection");
  const initialAccess = await createChalkPublicClient({ baseUrl: "https://api.chalk.test", fetch: async () => Response.json(original, { status: 201 }) }).refreshSpacePublicInviteAccess({ arrivalHandle: credential.arrivalHandle, mediaProof: original.media.token });
  const replacement = accessGrant("new-connection");
  const controller = new AbortController();
  let requestBody: unknown;
  let requestSignal: AbortSignal | null | undefined;
  let requestHeaders: Headers | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    requestBody = await new Response(init?.body).json();
    requestSignal = init?.signal;
    requestHeaders = new Headers(init?.headers);
    return Response.json(replacement, { status: 201 });
  });
  vi.stubGlobal("fetch", fetch);
  const getAccess = createGuestAccessGetter({ apiBaseURL: "https://api.chalk.test", credential, initialAccess });

  expect(await getAccess({ space: credential.slug, reason: "join", replaceMediaConnection: false })).toBe(initialAccess);
  expect(fetch).not.toHaveBeenCalled();
  const refreshed = await getAccess({ space: credential.slug, reason, replaceMediaConnection: true, signal: controller.signal });

  expect(requestBody).toEqual({ media_proof: original.media.token, replace_media_connection: true });
  expect(requestSignal?.aborted).toBe(false);
  controller.abort();
  expect(requestSignal?.aborted).toBe(true);
  expect(requestHeaders?.get("X-Chalk-Arrival-Handle")).toBe(credential.arrivalHandle);
  expect(refreshed).toMatchObject({ media: { client_payload: { connectionId: "new-connection" } } });
  expect(await getAccess({ space: credential.slug, reason: "join", replaceMediaConnection: false })).toBe(refreshed);
});

function accessGrant(connectionId: string) {
  const token = (aud: string) => `${Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url")}.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.signature`;
  return {
    subject: {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      space_id: "22222222-2222-4222-8222-222222222222",
      episode_id: "33333333-3333-4333-8333-333333333333",
      participant_id: "44444444-4444-4444-8444-444444444444",
      participant_generation: 1,
    },
    sync: { token: token("chalk-sync"), expires_at: "2099-01-01T00:00:00Z" },
    media: { token: token("chalk-media"), expires_at: "2099-01-01T00:00:00Z", provider: "cloudflare_sfu", client_payload: { connectionId, stunServer: "stun:example.test" } },
  };
}
