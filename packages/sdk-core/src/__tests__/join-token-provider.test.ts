import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConferenceClient } from "../client.ts";
import { createJoinTokenProvider, createSessionTokenProvider, extractJoinTokenFromInviteLink } from "../index.ts";

describe("extractJoinTokenFromInviteLink", () => {
  it("accepts Chalk https invite links", () => {
    expect(extractJoinTokenFromInviteLink("https://chalk.q9labs.ai/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts the new Chalk meet hostname", () => {
    expect(extractJoinTokenFromInviteLink("https://chalkmeet.com/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts native Chalk deep links", () => {
    expect(extractJoinTokenFromInviteLink("chalk://j/join-token-123")).toBe("join-token-123");
  });

  it("accepts bundle-scheme Chalk deep links for iOS compatibility", () => {
    expect(extractJoinTokenFromInviteLink("ai.q9labs.chalk.mobile://j/join-token-123")).toBe("join-token-123");
  });

  it("rejects direct room links and raw codes", () => {
    expect(extractJoinTokenFromInviteLink("https://chalk.q9labs.ai/room/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBeNull();
    expect(extractJoinTokenFromInviteLink("ABC123")).toBeNull();
  });
});

describe("createJoinTokenProvider", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          access_token: "jwt_123",
          expires_in: 900,
        }),
      };
    }) as typeof fetch;
  });

  it("exchanges once and reuses the cached room-scoped token until expiry", async () => {
    const tokenProvider = createJoinTokenProvider({
      apiUrl: "https://chalk-api.q9labs.ai",
      joinToken: "join-token-123",
    });

    await expect(tokenProvider()).resolves.toBe("jwt_123");
    await expect(tokenProvider()).resolves.toBe("jwt_123");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("createSessionTokenProvider", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        headers: {
          get: () => null,
        },
        json: async () => ({
          access_token: "jwt_refreshed",
          refresh_token: "refresh_next",
          expires_in: 900,
        }),
      };
    }) as typeof fetch;
  });

  it("reuses the joined access token until expiry", async () => {
    const tokenProvider = createSessionTokenProvider({
      apiUrl: "https://chalk-api.q9labs.ai",
      accessToken: "jwt_joined",
      refreshToken: "refresh_123",
      expiresAt: Date.now() + 60_000,
    });

    await expect(tokenProvider()).resolves.toBe("jwt_joined");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refreshes the joined access token after expiry", async () => {
    const tokenProvider = createSessionTokenProvider({
      apiUrl: "https://chalk-api.q9labs.ai",
      accessToken: "jwt_joined",
      refreshToken: "refresh_123",
      expiresAt: Date.now() - 1,
    });

    await expect(tokenProvider()).resolves.toBe("jwt_refreshed");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://chalk-api.q9labs.ai/api/v1/auth/refresh",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});

describe("ConferenceClient join token helpers", () => {
  it("joins with the canonical room id returned by join-token exchange", async () => {
    const client = new ConferenceClient({
      apiUrl: "https://chalk-api.q9labs.ai",
      token: "seed-token",
    });
    const apiClient = (client as unknown as { apiClient: { exchangeJoinToken: ReturnType<typeof mock>; setToken: ReturnType<typeof mock> } }).apiClient;
    apiClient.exchangeJoinToken = vi.fn(async () => ({
      success: true,
      data: {
        accessToken: "jwt_123",
        expiresIn: 900,
        roomId: "5cf88a28-a9a2-4937-b9ea-46caa2515948",
        roomName: "Proof Room",
      },
    }));
    apiClient.setToken = vi.fn(() => {});

    const joinSession = vi.fn(async () => ({ id: "5cf88a28-a9a2-4937-b9ea-46caa2515948" }));
    (client as unknown as { joinSession: typeof joinSession }).joinSession = joinSession;

    await client.joinWithJoinToken("join-token-123", {
      displayName: "Hasan",
    });

    expect(apiClient.exchangeJoinToken).toHaveBeenCalledWith("join-token-123");
    expect(apiClient.setToken).toHaveBeenCalledWith("jwt_123");
    expect(joinSession).toHaveBeenCalledWith("5cf88a28-a9a2-4937-b9ea-46caa2515948", {
      displayName: "Hasan",
    });
  });

  it("extracts the join token from invite links before joining", async () => {
    const client = new ConferenceClient({
      apiUrl: "https://chalk-api.q9labs.ai",
      token: "seed-token",
    });
    const joinWithJoinToken = vi.fn(async () => ({ id: "room-1" }));
    (client as unknown as { joinWithJoinToken: typeof joinWithJoinToken }).joinWithJoinToken = joinWithJoinToken;

    await client.joinWithInviteLink("https://chalk.q9labs.ai/j/join-token-123", {
      displayName: "Hasan",
    });

    expect(joinWithJoinToken).toHaveBeenCalledWith("join-token-123", {
      displayName: "Hasan",
    });
  });

  it("extracts the join token from chalkmeet invite links before joining", async () => {
    const client = new ConferenceClient({
      apiUrl: "https://chalk-api.q9labs.ai",
      token: "seed-token",
    });
    const joinWithJoinToken = vi.fn(async () => ({ id: "room-1" }));
    (client as unknown as { joinWithJoinToken: typeof joinWithJoinToken }).joinWithJoinToken = joinWithJoinToken;

    await client.joinWithInviteLink("https://chalkmeet.com/j/join-token-123", {
      displayName: "Hasan",
    });

    expect(joinWithJoinToken).toHaveBeenCalledWith("join-token-123", {
      displayName: "Hasan",
    });
  });
});
