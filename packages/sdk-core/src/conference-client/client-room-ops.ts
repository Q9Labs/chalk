import type { APIClient } from "../api-client.ts";
import { ConferenceSession } from "../room.ts";
import type { CreateJoinTokenResponse, ExchangeJoinTokenResponse, ListRoomsOptions, ListRoomsResponse, CreateRoomOptions, RoomResource, ScheduleRoomOptions } from "../types.ts";
import { wideEvents } from "../wide-events/index.ts";
import type { WSClient } from "../ws-client.ts";

export const createSession = async (apiClient: APIClient, name?: string, config?: Record<string, unknown>): Promise<string> => {
  const ctx = wideEvents.start("room.create");
  ctx.set("input", { name, config });

  try {
    const response = await apiClient.createSession(name, config);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to create room");
    }

    const roomId = response.data.id ?? response.data.roomId;
    if (!roomId) {
      throw new Error("Missing room ID in create room response");
    }

    ctx.complete("success", { roomId });
    return roomId;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const createRoom = async (apiClient: APIClient, options: CreateRoomOptions = {}): Promise<RoomResource> => {
  const ctx = wideEvents.start("room.create_resource");
  ctx.set("input", options);

  try {
    const response = await apiClient.createRoom(options);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to create room");
    }

    ctx.complete("success", { roomId: response.data.id, status: response.data.status });
    return response.data;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const scheduleRoom = async (apiClient: APIClient, options: ScheduleRoomOptions): Promise<RoomResource> => {
  const ctx = wideEvents.start("room.schedule");
  ctx.set("input", options);

  try {
    const response = await apiClient.scheduleRoom(options);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to schedule room");
    }

    ctx.complete("success", { roomId: response.data.id, status: response.data.status });
    return response.data;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const listRooms = async (apiClient: APIClient, options: ListRoomsOptions = {}): Promise<ListRoomsResponse> => {
  const ctx = wideEvents.start("room.list");
  ctx.set("input", options);

  try {
    const response = await apiClient.listRooms(options);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to list rooms");
    }

    ctx.complete("success", { count: response.data.rooms.length, total: response.data.total });
    return response.data;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const createJoinToken = async (apiClient: APIClient, roomId: string): Promise<CreateJoinTokenResponse> => {
  const ctx = wideEvents.start("room.create_join_token");
  ctx.set("input", { roomId });

  try {
    const response = await apiClient.createJoinToken(roomId);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to create join token");
    }

    ctx.complete("success");
    return response.data;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const exchangeJoinToken = async (apiClient: APIClient, joinToken: string): Promise<ExchangeJoinTokenResponse> => {
  const ctx = wideEvents.start("room.exchange_join_token");
  ctx.set("input", { hasJoinToken: !!joinToken });

  try {
    const response = await apiClient.exchangeJoinToken(joinToken);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to exchange join token");
    }

    ctx.complete("success");
    return response.data;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const endSession = async (apiClient: APIClient, sessionId: string): Promise<void> => {
  const ctx = wideEvents.start("room.end");
  ctx.set("input", { roomId: sessionId });

  try {
    const response = await apiClient.endSession(sessionId);
    if (!response.success) {
      throw new Error(response.error?.message ?? "Failed to end room");
    }
    ctx.complete("success");
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const startRecording = async (apiClient: APIClient, currentSession: ConferenceSession | null): Promise<string> => {
  const ctx = wideEvents.start("recording.start");

  try {
    if (!currentSession) {
      throw new Error("Not connected to a room");
    }

    ctx.set("input", { roomId: currentSession.id });
    const response = await apiClient.startRecording(currentSession.id);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to start recording");
    }

    ctx.complete("success", { recordingId: response.data.recordingId });
    return response.data.recordingId;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const stopRecording = async (apiClient: APIClient, currentSession: ConferenceSession | null): Promise<void> => {
  const ctx = wideEvents.start("recording.stop");

  try {
    if (!currentSession) {
      throw new Error("Not connected to a room");
    }

    ctx.set("input", { roomId: currentSession.id });
    const response = await apiClient.stopRecording(currentSession.id);
    if (!response.success) {
      throw new Error(response.error?.message ?? "Failed to stop recording");
    }

    ctx.complete("success");
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const presignWhiteboardUpload = async (apiClient: APIClient, roomId: string, fileId: string, mimeType: string): Promise<{ uploadUrl: string; expiresAtMs: number }> => {
  const ctx = wideEvents.start("whiteboard.presign_upload");
  ctx.set("input", { roomId, fileId, mimeType });

  try {
    const response = await apiClient.presignWhiteboardUpload(roomId, fileId, mimeType);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to presign upload");
    }

    ctx.complete("success");
    return response.data;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const presignWhiteboardDownload = async (apiClient: APIClient, roomId: string, fileId: string): Promise<{ downloadUrl: string; expiresAtMs: number }> => {
  const ctx = wideEvents.start("whiteboard.presign_download");
  ctx.set("input", { roomId, fileId });

  try {
    const response = await apiClient.presignWhiteboardDownload(roomId, fileId);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to presign download");
    }

    ctx.complete("success");
    return response.data;
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const removeParticipant = async (apiClient: APIClient, currentSession: ConferenceSession | null, apiParticipantId: string): Promise<void> => {
  const ctx = wideEvents.start("participant.remove");

  try {
    if (!currentSession) {
      throw new Error("Not connected to a room");
    }

    ctx.set("input", {
      roomId: currentSession.id,
      participantId: apiParticipantId,
    });

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(apiParticipantId)) {
      throw new Error(`Invalid participant ID format: "${apiParticipantId}". Use customParticipantId from the participant object.`);
    }

    if (apiParticipantId === currentSession.localParticipant?.id) {
      throw new Error("Cannot remove yourself from the room");
    }

    const response = await apiClient.removeParticipant(currentSession.id, apiParticipantId);
    if (!response.success) {
      throw new Error(response.error?.message ?? "Failed to remove participant");
    }

    ctx.complete("success");
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const updateOwnDisplayName = async (apiClient: APIClient, currentSession: ConferenceSession | null, displayName: string): Promise<void> => {
  const ctx = wideEvents.start("participant.update_self_name");
  const trimmedDisplayName = displayName.trim();
  ctx.set("input", {
    hasSession: currentSession !== null,
    displayNameLength: trimmedDisplayName.length,
  });

  try {
    if (!currentSession) {
      throw new Error("Not connected to a room");
    }
    if (!trimmedDisplayName) {
      throw new Error("Display name cannot be empty");
    }

    const response = await apiClient.updateParticipant(currentSession.id, "me", {
      displayName: trimmedDisplayName,
    });
    if (!response.success) {
      throw new Error(response.error?.message ?? "Failed to update display name");
    }

    currentSession.updateLocalParticipantDisplayName(trimmedDisplayName);
    ctx.complete("success");
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};

export const disconnectCurrentRoom = (currentSession: ConferenceSession | null, currentWsClient: WSClient | null, trackLeave: () => void): { nextSession: ConferenceSession | null; nextWsClient: WSClient | null } => {
  const ctx = wideEvents.start("room.leave");

  if (currentSession) {
    trackLeave();
    void currentSession.leave();
  }

  if (currentWsClient) {
    currentWsClient.disconnect();
  }

  ctx.complete("success");
  return { nextSession: null, nextWsClient: null };
};
