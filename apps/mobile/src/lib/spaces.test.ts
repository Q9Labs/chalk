import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
const expoConstants = vi.hoisted(() => ({
  expoConfig: { extra: { brokerUrl: "https://chalkmeet.com/local-chalk", telemetryEnabled: false } },
}));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("expo-constants", () => ({ default: expoConstants }));
vi.mock("@q9labsai/chalk-react-native/runtime", () => ({
  getDeviceInfo: vi.fn(),
  getReactNativeScriptUrl: vi.fn(),
  resolveAppRuntimeUrl: vi.fn(),
}));

import { cleanupParticipantCredential, createAccessGrantGetter, enterLocalSpaceRoute, getClipboardSpaceSuggestion, parseSpaceLink, prepareParticipantCredential, spaceInviteLink } from "./spaces";

const spaceInviteToken = "i".repeat(43);
const participantCredentialId = "c".repeat(43);
const apiBaseURL = "https://api.chalk.video";
const syncURL = "wss://sync.chalk.video/v1/sync";

describe("space links", () => {
  it("enters the existing local Space without claiming durable creation", async () => {
    await expect(enterLocalSpaceRoute("  Team space  ")).resolves.toEqual({ kind: "space", space: "local-space", spaceName: "Team space", source: "local-space" });
  });

  it("accepts canonical Space links and keeps the token in the fragment", () => {
    expect(parseSpaceLink(`https://chalkmeet.com/space#spaceInviteToken=${spaceInviteToken}`)).toEqual({
      kind: "space",
      space: "local-space",
      spaceInviteToken,
      source: "space-link",
    });
    expect(getClipboardSpaceSuggestion(`https://chalk.q9labs.ai/space#spaceInviteToken=${spaceInviteToken}`)).toBe(`https://chalk.q9labs.ai/space#spaceInviteToken=${spaceInviteToken}`);
    expect(spaceInviteLink(spaceInviteToken)).toBe(`https://chalkmeet.com/space#spaceInviteToken=${spaceInviteToken}`);
  });

  it("rejects paths that do not target the Space", () => {
    expect(parseSpaceLink(`https://chalkmeet.com/other#spaceInviteToken=${spaceInviteToken}`)).toBeNull();
    expect(parseSpaceLink(`https://chalkmeet.com/space?spaceInviteToken=${spaceInviteToken}`)).toBeNull();
  });
});

describe("participant credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureStore.deleteItemAsync.mockResolvedValue();
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync.mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("retains validated broker endpoints before asking Chalk for opaque access", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ apiBaseURL, participantCredentialId, spaceInviteToken, syncURL }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ any: "opaque access grant" }));

    const credential = await prepareParticipantCredential({
      brokerUrl: "https://chalkmeet.com/local-chalk",
      displayName: "Ada",
      spaceInviteToken,
    });
    const getAccess = createAccessGrantGetter({ brokerUrl: "https://chalkmeet.com/local-chalk", credential });
    const access = await getAccess({ reason: "retry", space: "local-space" });

    expect(credential).toEqual({ apiBaseURL, participantCredentialId, spaceInviteToken, syncURL });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://chalkmeet.com/local-chalk/participant-credentials",
      expect.objectContaining({
        body: JSON.stringify({ displayName: "Ada", spaceInviteToken }),
        method: "POST",
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://chalkmeet.com/local-chalk/access-grants",
      expect.objectContaining({
        body: JSON.stringify({ participantCredentialId, replaceMediaConnection: true, spaceInviteToken }),
        method: "POST",
      }),
    );
    expect(access).toEqual({ any: "opaque access grant" });
  });

  it("clears an expired stored credential and retries without it", async () => {
    secureStore.getItemAsync.mockResolvedValueOnce(JSON.stringify({ apiBaseURL, participantCredentialId, spaceInviteToken, syncURL }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("expired", { status: 410 }))
      .mockResolvedValueOnce(Response.json({ apiBaseURL, participantCredentialId, spaceInviteToken, syncURL }, { status: 201 }));

    await expect(prepareParticipantCredential({ brokerUrl: "https://chalkmeet.com/local-chalk", displayName: "Ada", spaceInviteToken })).resolves.toEqual({ apiBaseURL, participantCredentialId, spaceInviteToken, syncURL });

    expect(fetch).toHaveBeenNthCalledWith(1, "https://chalkmeet.com/local-chalk/participant-credentials", expect.objectContaining({ body: JSON.stringify({ displayName: "Ada", participantCredentialId, spaceInviteToken }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, "https://chalkmeet.com/local-chalk/participant-credentials", expect.objectContaining({ body: JSON.stringify({ displayName: "Ada", spaceInviteToken }) }));
  });

  it("cleans up the broker credential after leaving a Space", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await cleanupParticipantCredential({
      brokerUrl: "https://chalkmeet.com/local-chalk",
      credential: { apiBaseURL, participantCredentialId, spaceInviteToken, syncURL },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://chalkmeet.com/local-chalk/participant-credentials/cleanup",
      expect.objectContaining({
        body: JSON.stringify({ participantCredentialId, spaceInviteToken }),
        method: "POST",
      }),
    );
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(`chalk_mobile_participant_credential_v4.${spaceInviteToken}`);
  });

  it("rejects participant credentials with malformed endpoints before saving them", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ apiBaseURL: "file:///private/api", participantCredentialId, spaceInviteToken, syncURL }, { status: 201 }));

    await expect(prepareParticipantCredential({ brokerUrl: "https://chalkmeet.com/local-chalk", displayName: "Ada", spaceInviteToken })).rejects.toThrow("Participant credential is invalid.");
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("retains the local credential after a transient cleanup failure and retries later", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      cleanupParticipantCredential({
        brokerUrl: "https://chalkmeet.com/local-chalk",
        credential: { apiBaseURL, participantCredentialId, spaceInviteToken, syncURL },
      }),
    ).rejects.toThrow("unavailable");

    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();

    await expect(
      cleanupParticipantCredential({
        brokerUrl: "https://chalkmeet.com/local-chalk",
        credential: { apiBaseURL, participantCredentialId, spaceInviteToken, syncURL },
      }),
    ).resolves.toBeUndefined();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(`chalk_mobile_participant_credential_v4.${spaceInviteToken}`);
  });

  it.each([401, 404, 410])("clears the local credential when cleanup confirms terminal absence with HTTP %s", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));

    await expect(
      cleanupParticipantCredential({
        brokerUrl: "https://chalkmeet.com/local-chalk",
        credential: { apiBaseURL, participantCredentialId, spaceInviteToken, syncURL },
      }),
    ).resolves.toBeUndefined();

    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(`chalk_mobile_participant_credential_v4.${spaceInviteToken}`);
  });
});
