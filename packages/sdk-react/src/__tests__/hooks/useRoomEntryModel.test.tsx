// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRoomEntryModel } from "../../hooks/useRoomEntryModel";

const {
  APIClientMock,
  createJoinTokenMock,
  getRoomJoinAvailabilityMock,
  getRoomMock,
  isCanonicalRoomIdMock,
} = vi.hoisted(() => ({
  APIClientMock: vi.fn(),
  createJoinTokenMock: vi.fn(),
  getRoomJoinAvailabilityMock: vi.fn(),
  getRoomMock: vi.fn(),
  isCanonicalRoomIdMock: vi.fn(),
}));

vi.mock("@q9labs/chalk-core", () => ({
  APIClient: class MockAPIClient {
    constructor(...args: unknown[]) {
      APIClientMock(...args);
    }

    createJoinToken(roomId: string) {
      return createJoinTokenMock(roomId);
    }

    getRoom(roomId: string) {
      return getRoomMock(roomId);
    }
  },
  getRoomJoinAvailability: getRoomJoinAvailabilityMock,
  isCanonicalRoomId: isCanonicalRoomIdMock,
}));

describe("useRoomEntryModel", () => {
  beforeEach(() => {
    getRoomMock.mockReset();
    createJoinTokenMock.mockReset();
    getRoomJoinAvailabilityMock.mockReset();
    isCanonicalRoomIdMock.mockReset();
    APIClientMock.mockReset();

    getRoomJoinAvailabilityMock.mockImplementation((room: { id: string } | null, nowMs?: number) => ({
      isJoinAllowed: true,
      kind: room ? "scheduled" : "open",
      opensAtMs: room ? 1700000000000 : null,
      remainingMs: null,
      startsAtMs: room ? nowMs ?? 1700000300000 : null,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads room metadata and meeting links for canonical room ids", async () => {
    isCanonicalRoomIdMock.mockReturnValue(true);
    getRoomMock.mockResolvedValue({
      data: {
        id: "room_123",
        name: "Scheduled Algebra",
      },
      success: true,
    });
    createJoinTokenMock.mockResolvedValue({
      data: {
        joinToken: "join-token-123",
      },
      success: true,
    });

    const tokenProvider = vi.fn(async () => "access-123");
    const { result } = renderHook(() =>
      useRoomEntryModel({
        apiUrl: "https://api.chalk.test",
        nowMs: 1700000000000,
        publicAppUrl: "https://chalk.q9labs.ai",
        roomId: "room_123",
        tokenProvider,
      }),
    );

    await waitFor(() => {
      expect(result.current.room).toMatchObject({
        id: "room_123",
        name: "Scheduled Algebra",
      });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.meetingLink).toBe("http://localhost/j/join-token-123");
    expect(result.current.role).toBe("host");
    expect(result.current.shouldForceInternalAuth).toBe(true);
    expect(result.current.availability.kind).toBe("scheduled");
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(getRoomMock).toHaveBeenCalledWith("room_123");
    expect(createJoinTokenMock).toHaveBeenCalledWith("room_123");
  });

  it("uses join context directly for participant links without forcing internal auth", async () => {
    isCanonicalRoomIdMock.mockReturnValue(false);

    const tokenProvider = vi.fn(async () => "access-123");
    const { result } = renderHook(() =>
      useRoomEntryModel({
        apiUrl: "https://api.chalk.test",
        authMode: "internal",
        joinContext: {
          joinToken: "public-token-456",
        },
        publicAppUrl: "https://chalk.q9labs.ai",
        roomId: "friendly-room",
        tokenProvider,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.role).toBe("participant");
    expect(result.current.meetingLink).toBe("http://localhost/j/public-token-456");
    expect(result.current.room).toBeNull();
    expect(result.current.shouldForceInternalAuth).toBe(false);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(getRoomMock).not.toHaveBeenCalled();
    expect(createJoinTokenMock).not.toHaveBeenCalled();
  });
});
