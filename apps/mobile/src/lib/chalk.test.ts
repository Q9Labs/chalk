import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("@q9labsai/chalk-react-native/diagnostics", () => ({ maskSecret: vi.fn() }));
vi.mock("@q9labsai/chalk-react-native/invites", () => ({ extractJoinTokenFromInviteLink: vi.fn() }));
vi.mock("@q9labsai/chalk-react-native/runtime", () => ({
  getDeviceInfo: vi.fn(),
  getReactNativeScriptUrl: vi.fn(),
  resolveAppRuntimeUrl: vi.fn(),
}));

import { cleanupClientSession, loadClientSessionCredential, saveClientSessionCredential } from "./chalk";

const inviteToken = "i".repeat(43);
const credential = {
  clientSessionId: "c".repeat(43),
  inviteToken,
};

describe("client-session credential storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureStore.deleteItemAsync.mockResolvedValue();
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync.mockResolvedValue();
  });

  it("uses only Expo SecureStore-compatible key characters", async () => {
    await saveClientSessionCredential(credential);

    const keys = secureStore.setItemAsync.mock.calls.map(([key]) => key);
    expect(keys).toContain(`chalk_mobile_client_session_v2.${inviteToken}`);
    expect(keys.every((key) => /^[A-Za-z0-9._-]+$/u.test(key))).toBe(true);

    secureStore.getItemAsync.mockResolvedValueOnce(JSON.stringify(credential));
    await expect(loadClientSessionCredential(inviteToken)).resolves.toEqual(credential);
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(`chalk_mobile_client_session_v2.${inviteToken}`);
  });

  it("clears the persisted credential when broker cleanup fails", async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    secureStore.getItemAsync.mockResolvedValueOnce(inviteToken);

    await expect(
      cleanupClientSession({
        ...credential,
        apiBaseURL: "https://api.chalkmeet.com",
        syncURL: "wss://sync.chalkmeet.com/v3/sync",
        meetingLink: `https://chalkmeet.com/#meeting=${inviteToken}`,
        access: vi.fn(),
        cleanup,
      }),
    ).rejects.toThrow("cleanup failed");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(`chalk_mobile_client_session_v2.${inviteToken}`);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("chalk_mobile_last_invite_v2");
  });
});
