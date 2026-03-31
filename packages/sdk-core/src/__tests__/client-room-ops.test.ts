import { describe, expect, it, vi } from "vitest";
import { createJoinToken, createRoom, createSession, exchangeJoinToken, listRooms, scheduleRoom, updateOwnDisplayName } from "../conference-client/client-room-ops.ts";

describe("client-room-ops", () => {
  it("createSession returns id when API returns Room payload", async () => {
    const apiClient = {
      createSession: async () => ({
        success: true,
        data: {
          id: "room_uuid_1",
          status: "active",
        },
      }),
    };

    await expect(createSession(apiClient as any)).resolves.toBe("room_uuid_1");
  });

  it("createSession throws when room id is missing", async () => {
    const apiClient = {
      createSession: async () => ({
        success: true,
        data: {
          status: "active",
        },
      }),
    };

    await expect(createSession(apiClient as any)).rejects.toThrow("Missing room ID in create room response");
  });

  it("createRoom returns normalized room resource", async () => {
    const apiClient = {
      createRoom: async () => ({
        success: true,
        data: {
          id: "room_uuid_2",
          status: "active",
        },
      }),
    };

    await expect(createRoom(apiClient as any, { name: "Math" })).resolves.toMatchObject({
      id: "room_uuid_2",
      status: "active",
    });
  });

  it("scheduleRoom returns scheduled resource", async () => {
    const apiClient = {
      scheduleRoom: async () => ({
        success: true,
        data: {
          id: "room_uuid_3",
          status: "scheduled",
        },
      }),
    };

    await expect(
      scheduleRoom(apiClient as any, {
        name: "Physics",
        scheduledStartAt: "2026-03-10T14:00:00Z",
      }),
    ).resolves.toMatchObject({
      id: "room_uuid_3",
      status: "scheduled",
    });
  });

  it("listRooms returns typed room list payload", async () => {
    const apiClient = {
      listRooms: async () => ({
        success: true,
        data: {
          rooms: [{ id: "room_uuid_4", status: "scheduled" }],
          total: 1,
          limit: 20,
          offset: 0,
        },
      }),
    };

    await expect(listRooms(apiClient as any, { status: ["scheduled"] })).resolves.toMatchObject({
      total: 1,
      rooms: [{ id: "room_uuid_4", status: "scheduled" }],
    });
  });

  it("createJoinToken returns join token payload", async () => {
    const apiClient = {
      createJoinToken: async () => ({
        success: true,
        data: { joinToken: "tok_123" },
      }),
    };

    await expect(createJoinToken(apiClient as any, "room_uuid_5")).resolves.toEqual({
      joinToken: "tok_123",
    });
  });

  it("exchangeJoinToken returns access token payload", async () => {
    const apiClient = {
      exchangeJoinToken: async () => ({
        success: true,
        data: {
          accessToken: "jwt_123",
          expiresIn: 900,
          roomId: "room_uuid_6",
          roomName: "Phantom Tea",
        },
      }),
    };

    await expect(exchangeJoinToken(apiClient as any, "tok_abc")).resolves.toMatchObject({
      accessToken: "jwt_123",
      roomId: "room_uuid_6",
      roomName: "Phantom Tea",
    });
  });

  it("updates the local participant display name via the me endpoint", async () => {
    const apiClient = {
      updateParticipant: vi.fn(async () => ({
        success: true,
      })),
    };
    const currentSession = {
      id: "room_uuid_7",
      updateLocalParticipantDisplayName: vi.fn(),
    };

    await expect(updateOwnDisplayName(apiClient as any, currentSession as any, "  Alicia  ")).resolves.toBeUndefined();
    expect(apiClient.updateParticipant).toHaveBeenCalledWith("room_uuid_7", "me", {
      displayName: "Alicia",
    });
    expect(currentSession.updateLocalParticipantDisplayName).toHaveBeenCalledWith("Alicia");
  });

  it("rejects blank display names", async () => {
    const apiClient = {
      updateParticipant: vi.fn(),
    };
    const currentSession = {
      id: "room_uuid_8",
      updateLocalParticipantDisplayName: vi.fn(),
    };

    await expect(updateOwnDisplayName(apiClient as any, currentSession as any, "   ")).rejects.toThrow("Display name cannot be empty");
    expect(apiClient.updateParticipant).not.toHaveBeenCalled();
    expect(currentSession.updateLocalParticipantDisplayName).not.toHaveBeenCalled();
  });
});
