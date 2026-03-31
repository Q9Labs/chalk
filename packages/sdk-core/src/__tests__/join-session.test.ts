import { describe, expect, it, vi } from "vitest";
import { joinConferenceSession } from "../conference-client/join-session.ts";

describe("joinConferenceSession", () => {
  it("switches API auth onto the joined session token provider", async () => {
    const setToken = vi.fn(() => {});
    const setTokenProvider = vi.fn(() => {});
    const apiClient = {
      addParticipant: vi.fn(async () => ({
        success: true,
        data: {
          participantId: "p_1",
          role: "participant",
          tokens: {
            accessToken: "access_joined",
            refreshToken: "refresh_joined",
            expiresAt: Date.now() + 60_000,
            rtcToken: "rtc_joined",
          },
          room: {
            id: "room_1",
            name: "Room 1",
            status: "active",
            participantCount: 1,
            config: {},
            createdAt: new Date(),
          },
        },
      })),
      setToken,
      setTokenProvider,
      getApiUrl: () => "https://chalk-api.q9labs.ai",
    };

    const rtkClient = {
      self: {
        on: () => () => {},
      },
      participants: {
        joined: {
          on: () => () => {},
        },
      },
    };

    await joinConferenceSession(
      "room_1",
      {
        displayName: "Hasan",
        audio: true,
        video: true,
      },
      {
        apiUrl: "https://chalk-api.q9labs.ai",
        apiClient: apiClient as any,
        demoMode: false,
        wsUrl: "",
        debug: false,
        isTokenExpired: () => false,
        emitTokenExpired: () => {},
        initRealtimeKitClient: vi.fn(async () => rtkClient as any),
        joinRealtimeKitWithRetry: vi.fn(async () => {}),
      },
    );

    expect(setToken).toHaveBeenCalledWith("access_joined");
    expect(setTokenProvider).toHaveBeenCalledTimes(1);
    const provider = setTokenProvider.mock.calls[0]?.[0];
    expect(typeof provider).toBe("function");
  });
});
