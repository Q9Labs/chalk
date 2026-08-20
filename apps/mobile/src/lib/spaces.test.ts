import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccessGrant } from "@q9labsai/chalk-client/access";

const secureStore = vi.hoisted(() => ({
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

const publicClient = vi.hoisted(() => ({
  arriveBySpacePublicInvite: vi.fn(),
  createPublicSpace: vi.fn(),
  getSpacePublicInviteArrival: vi.fn(),
  leaveSpacePublicInviteArrival: vi.fn(),
  refreshSpacePublicInviteAccess: vi.fn(),
}));
const createPublicClient = vi.hoisted(() => vi.fn(() => publicClient));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("@q9labsai/chalk-client/invites", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@q9labsai/chalk-client/invites")>();
  return { ...actual, createChalkPublicClient: createPublicClient };
});
vi.mock("@q9labsai/chalk-react-native/invites", () => ({
  parseSpaceInviteLink: (input: string) => {
    const match = /^https:\/\/chalkmeet\.com\/space\/([^#]+)#spaceInviteToken=([^#]+)$/u.exec(input);
    return match ? { slug: match[1], spaceInviteToken: match[2] } : null;
  },
}));

import { cleanupSpaceArrival, createGuestAccessGetter, createPublicSpaceRoute, getClipboardSpaceSuggestion, parseSpaceLink, prepareSpaceArrival, type SpaceRoute, type StoredSpaceArrival } from "./spaces";

const token = "cspi1.header.payload.signature";
const localApiBaseURL = "http://127.0.0.1:8787";
const inviteLink = `https://chalkmeet.com/space/team#spaceInviteToken=${token}`;
const route: SpaceRoute = { kind: "space", space: "team", spaceInviteToken: token, inviteLink, source: "space-link" };
const mediaCredential = `v1.${Buffer.from(JSON.stringify({ aud: "chalk-media" })).toString("base64url")}.signature`;
const access = parseAccessGrant({
  media: { client_payload: { provider_subject: "subject", token: "provider-token" }, expires_at: "2030-01-01T00:00:00.000Z", provider: "cloudflare_rtk", token: mediaCredential },
  subject: { episode_id: "episode", participant_generation: 1, participant_id: "participant", space_id: "team", tenant_id: "tenant" },
  sync: { expires_at: "2030-01-01T00:00:00.000Z", token: `v1.${Buffer.from(JSON.stringify({ aud: "chalk-sync" })).toString("base64url")}.signature` },
});
const arrival = { arrival_handle: "arrival-handle", guest_credential: "guest-credential", state: "active", access };
const stored: StoredSpaceArrival = { arrivalHandle: "arrival-handle", guestCredential: "guest-credential", slug: "team", spaceInviteToken: token };

describe("space links", () => {
  it("parses canonical links with a slug and cspi token", () => {
    expect(parseSpaceLink(inviteLink)).toEqual(route);
    expect(getClipboardSpaceSuggestion(` https://chalkmeet.com/space/team#spaceInviteToken=${token} `)).toContain("/space/team#");
  });

  it("rejects legacy and non-Space paths", () => {
    expect(parseSpaceLink("https://chalkmeet.com/legacy/join?invite=old")).toBeNull();
    expect(parseSpaceLink(`https://chalkmeet.com/space?spaceInviteToken=${token}`)).toBeNull();
  });
});

describe("public Space arrivals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync.mockResolvedValue();
    secureStore.deleteItemAsync.mockResolvedValue();
    publicClient.createPublicSpace.mockResolvedValue({
      arrival,
      guest_credential: "guest-credential",
      invite_link: inviteLink,
      space: { name: "Team" },
    });
    publicClient.arriveBySpacePublicInvite.mockResolvedValue(arrival);
    publicClient.getSpacePublicInviteArrival.mockResolvedValue({ ...arrival, state: "active" });
    publicClient.refreshSpacePublicInviteAccess.mockResolvedValue({ media: { token: "refreshed-proof" } });
    publicClient.leaveSpacePublicInviteArrival.mockResolvedValue(undefined);
  });

  it("creates a public Space and stores the per-arrival handle and credential", async () => {
    const result = await createPublicSpaceRoute({ apiBaseURL: localApiBaseURL, displayName: "Ada" });

    expect(publicClient.createPublicSpace).toHaveBeenCalledWith({ displayName: "Ada" }, expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(result.route).toEqual({ kind: "space", space: "team", spaceInviteToken: token, inviteLink, source: "created-space", spaceName: "Team" });
    expect(result.arrival.credential).toEqual(stored);
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(expect.stringContaining("chalk_mobile_public_arrival_v1.arrival-handle"), JSON.stringify(stored));
  });

  it("rejects a raw token instead of synthesizing an invite link", async () => {
    publicClient.createPublicSpace.mockResolvedValueOnce({
      arrival,
      guest_credential: "guest-credential",
      invite_link: token,
      space: { name: "Team" },
    });

    await expect(createPublicSpaceRoute({ apiBaseURL: localApiBaseURL, displayName: "Ada" })).rejects.toThrow("invalid Space invite link");
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("resumes an active arrival through status and arrival", async () => {
    secureStore.getItemAsync.mockResolvedValueOnce("arrival-handle").mockResolvedValueOnce(JSON.stringify(stored));

    const result = await prepareSpaceArrival({ apiBaseURL: localApiBaseURL, route, displayName: "Ada" });

    expect(publicClient.getSpacePublicInviteArrival).toHaveBeenCalledWith({ arrivalHandle: stored.arrivalHandle, guestCredential: stored.guestCredential });
    expect(publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith({ displayName: "Ada", spaceInviteToken: token }, expect.objectContaining({ arrivalHandle: stored.arrivalHandle, guestCredential: stored.guestCredential }));
    expect(createPublicClient).toHaveBeenLastCalledWith({ baseUrl: localApiBaseURL, guestCredential: stored.guestCredential, runtime: "react-native" });
    expect(result.credential).toEqual(stored);
  });

  it("uses the configured API origin for create, status, arrival, refresh, and leave", async () => {
    await createPublicSpaceRoute({ apiBaseURL: localApiBaseURL, displayName: "Ada" });
    secureStore.getItemAsync.mockResolvedValueOnce("arrival-handle").mockResolvedValueOnce(JSON.stringify(stored));
    await prepareSpaceArrival({ apiBaseURL: localApiBaseURL, route, displayName: "Ada" });
    const getAccess = createGuestAccessGetter({ apiBaseURL: localApiBaseURL, credential: stored, initialAccess: access });
    await getAccess({ reason: "retry", space: "team" });
    await cleanupSpaceArrival({ apiBaseURL: localApiBaseURL, credential: stored });

    expect(createPublicClient).toHaveBeenNthCalledWith(1, { baseUrl: localApiBaseURL, guestCredential: undefined, runtime: "react-native" });
    expect(createPublicClient).toHaveBeenNthCalledWith(2, { baseUrl: localApiBaseURL, guestCredential: stored.guestCredential, runtime: "react-native" });
    expect(createPublicClient).toHaveBeenNthCalledWith(3, { baseUrl: localApiBaseURL, guestCredential: stored.guestCredential, runtime: "react-native" });
    expect(createPublicClient).toHaveBeenNthCalledWith(4, { baseUrl: localApiBaseURL, guestCredential: stored.guestCredential, runtime: "react-native" });
  });

  it("drops a terminal stored arrival before starting a fresh arrival", async () => {
    secureStore.getItemAsync.mockResolvedValueOnce("arrival-handle").mockResolvedValueOnce(JSON.stringify(stored));
    publicClient.getSpacePublicInviteArrival.mockResolvedValueOnce({ ...arrival, state: "unavailable" });

    await expect(prepareSpaceArrival({ apiBaseURL: localApiBaseURL, route, displayName: "Ada" })).resolves.toMatchObject({ credential: stored });
    expect(publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith({ displayName: "Ada", spaceInviteToken: token }, expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("chalk_mobile_public_arrival_v1.arrival-handle");
  });

  it("refreshes access with the current media proof", async () => {
    const getAccess = createGuestAccessGetter({ apiBaseURL: localApiBaseURL, credential: stored, initialAccess: access });

    await expect(getAccess({ reason: "join", space: "team" })).resolves.toEqual(access);
    await expect(getAccess({ reason: "retry", space: "team" })).resolves.toEqual({ media: { token: "refreshed-proof" } });
    expect(publicClient.refreshSpacePublicInviteAccess).toHaveBeenCalledWith({ arrivalHandle: stored.arrivalHandle, guestCredential: stored.guestCredential, mediaProof: mediaCredential }, expect.objectContaining({ arrivalHandle: stored.arrivalHandle, guestCredential: stored.guestCredential }));
  });

  it("leaves the arrival and clears secure state", async () => {
    await cleanupSpaceArrival({ apiBaseURL: localApiBaseURL, credential: stored });

    expect(publicClient.leaveSpacePublicInviteArrival).toHaveBeenCalledWith({ arrivalHandle: stored.arrivalHandle, guestCredential: stored.guestCredential });
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("chalk_mobile_public_arrival_v1.arrival-handle");
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(`chalk_mobile_public_arrival_index_v1.${token}`);
  });

  it("clears state when the server confirms a terminal arrival", async () => {
    publicClient.leaveSpacePublicInviteArrival.mockRejectedValueOnce({ status: 410 });

    await expect(cleanupSpaceArrival({ apiBaseURL: localApiBaseURL, credential: stored })).resolves.toBeUndefined();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("chalk_mobile_public_arrival_v1.arrival-handle");
  });

  it("clears state for the typed unavailable-arrival error", async () => {
    publicClient.leaveSpacePublicInviteArrival.mockRejectedValueOnce({ error: { code: "arrival.unavailable" } });

    await expect(cleanupSpaceArrival({ apiBaseURL: localApiBaseURL, credential: stored })).resolves.toBeUndefined();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(`chalk_mobile_public_arrival_index_v1.${token}`);
  });
});
