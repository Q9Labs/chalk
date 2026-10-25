import { readFileSync } from "node:fs";
import { createExpoConfig } from "../../app.config";
import { afterEach, expect, it, vi } from "vitest";
import { openBrowserAsync } from "expo-web-browser";
import { createChalkPublicClient } from "@q9labsai/chalk-client/invites";
import { createGuestAccessGetter, parseSpaceLink, routeMobileLink } from "./spaces";

vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: vi.fn() }));
afterEach(() => vi.clearAllMocks());
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

it.each(["chalkmeet.com", "chalk.q9labs.ai"])("routes short and existing Space links on %s without opening a browser", async (host) => {
  for (const path of ["/abc-defg-hij", "/space/example#spaceInviteToken=cspi1.key.payload.signature"]) {
    const link = `https://${host}${path}`;
    expect(await routeMobileLink(link)).toEqual(parseSpaceLink(link));
    expect(await routeMobileLink(link)).not.toBeNull();
  }
  expect(openBrowserAsync).not.toHaveBeenCalled();
});

it.each(["chalkmeet.com", "chalk.q9labs.ai"])("opens unparsed %s links in a browser, including future shapes", async (host) => {
  for (const path of ["/future/call", "/space/", "/abc-1234-hij", "/abc-defg-hij?future=1", "/privacy"]) {
    const link = `https://${host}${path}`;
    expect(await routeMobileLink(link)).toBeNull();
    expect(openBrowserAsync).toHaveBeenLastCalledWith(link);
  }
});

it.each([null, "not a URL", "chalk://unknown", "https://example.test/future", "https://chalkmeet.com.example.test/future"])("does not open unrelated or malformed input %s", async (input) => {
  expect(await routeMobileLink(input)).toBeNull();
  expect(openBrowserAsync).not.toHaveBeenCalled();
});

it("propagates browser failures to the link handler's error reporter", async () => {
  vi.mocked(openBrowserAsync).mockRejectedValueOnce(new Error("Browser unavailable"));
  await expect(routeMobileLink("https://chalkmeet.com/future")).rejects.toThrow("Browser unavailable");
});

it("associates only the short-link path shape and preserves the existing Space filter", () => {
  const filters = createExpoConfig().expo.android.intentFilters;
  const spaceFilter = filters[0];
  const codeFilter = filters[1];
  expect(spaceFilter?.autoVerify).toBe(true);
  expect(spaceFilter?.data).toEqual(["chalkmeet.com", "chalk.q9labs.ai"].map((host) => ({ scheme: "https", host, pathPrefix: "/space" })));
  expect(codeFilter?.autoVerify).toBe(true);
  expect(codeFilter?.category).toEqual(["BROWSABLE", "DEFAULT"]);
  expect(codeFilter?.data).toEqual(["chalkmeet.com", "chalk.q9labs.ai"].map((host) => ({ scheme: "https", host, pathPattern: "/...-....-..." })));
  const manifest = readFileSync(new URL("../../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  for (const host of ["chalkmeet.com", "chalk.q9labs.ai"]) {
    expect(manifest).toContain(`android:host="${host}" android:pathPattern="/...-....-..."`);
    expect(manifest).toContain(`android:host="${host}" android:pathPrefix="/space"`);
  }
  // Android's simple glob: dots consume exactly one character, and the whole path must match.
  const codePattern = codeFilter?.data.find((data) => "pathPattern" in data)?.pathPattern;
  const codePath = new RegExp(`^${codePattern}$`, "u");
  expect(codePath.test("/abc-defg-hij")).toBe(true);
  for (const path of ["/", "/dashboard", "/dashboard/sign-in", "/dashboard/developer", "/docs", "/docs/chat", "/privacy", "/privacy/previous", "/privacy-policy", "/terms", "/space/example", "/abc-defg-hi", "/abcd-efg-hij", "/abc-defg-hij/"]) {
    expect(codePath.test(path), path).toBe(false);
  }
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
