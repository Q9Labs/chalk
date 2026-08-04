import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
const inviteExtractor = vi.hoisted(() => vi.fn<(url: string) => string | null>());

vi.mock("expo-secure-store", () => secureStore);
vi.mock("@q9labsai/chalk-react-native/diagnostics", () => ({ maskSecret: vi.fn() }));
vi.mock("@q9labsai/chalk-react-native/invites", () => ({ extractJoinTokenFromInviteLink: inviteExtractor }));
vi.mock("@q9labsai/chalk-react-native/runtime", () => ({
  getDeviceInfo: vi.fn(),
  getReactNativeScriptUrl: vi.fn(),
  resolveAppRuntimeUrl: vi.fn(),
}));

import { cleanupClientSession, loadClientSessionCredential, parseMobileRoute, parseUrlLike, saveClientSessionCredential } from "./chalk";

const inviteToken = "i".repeat(43);
const credential = {
  clientSessionId: "c".repeat(43),
  inviteToken,
};

describe("credential storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureStore.deleteItemAsync.mockResolvedValue();
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync.mockResolvedValue();
  });

  it("uses only Expo SecureStore-compatible key characters", async () => {
    await saveClientSessionCredential(credential);

    const keys = secureStore.setItemAsync.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^[A-Za-z0-9._-]+$/u.test(key))).toBe(true);

    secureStore.getItemAsync.mockResolvedValueOnce(JSON.stringify(credential));
    await expect(loadClientSessionCredential(inviteToken)).resolves.toEqual(credential);
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(keys[0]);
  });

  it("clears the persisted credential when broker cleanup fails", async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    secureStore.getItemAsync.mockResolvedValueOnce(inviteToken);

    const cleanupClient = {
      ...credential,
      apiBaseURL: "https://api.chalkmeet.com",
      syncURL: "wss://sync.chalkmeet.com/v1/sync",
      meetingLink: `https://chalkmeet.com/#meeting=${inviteToken}`,
      access: vi.fn(),
      cleanup,
    } as unknown as Parameters<typeof cleanupClientSession>[0];

    await expect(cleanupClientSession(cleanupClient)).rejects.toThrow("cleanup failed");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(secureStore.deleteItemAsync.mock.calls[0]?.[0]).toContain(inviteToken);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("chalk_mobile_last_invite_v2");
  });
});

describe("mobile link routing", () => {
  beforeEach(() => {
    inviteExtractor.mockReset();
    inviteExtractor.mockReturnValue(null);
  });

  it("handles development SDK preview links before invite parsing", () => {
    inviteExtractor.mockImplementation(() => {
      throw new Error("invite parsing should not run for a preview link");
    });

    expect(parseMobileRoute("chalk://sdk-preview?view=space&state=retry", { isDevRuntime: true })).toMatchObject({ kind: "sdk-preview", preview: { view: "space", state: "retry" } });
  });

  it("rejects SDK preview links outside development while preserving invite parsing", () => {
    inviteExtractor.mockImplementation((url) => (url.startsWith("https://") ? "invite-token" : null));

    expect(parseMobileRoute("chalk://sdk-preview?view=space", { isDevRuntime: false })).toBeNull();
    expect(parseMobileRoute("https://chalkmeet.com/j/invite-token", { isDevRuntime: false })).toMatchObject({ kind: "lobby", joinToken: "invite-token", source: "join-link" });
    expect(parseUrlLike("https://chalkmeet.com/j/invite-token")).toMatchObject({ kind: "lobby", joinToken: "invite-token" });
  });
});
