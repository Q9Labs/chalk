import { APIClient } from "./api-client.ts";
import { createRoom } from "./conference-client/client-room-ops.ts";
import type { CreateRoomConfig, RoomResource } from "./types.ts";

export interface RoomScheduleMetadata {
  scheduledStartAt?: string | Date | null;
  scheduled_start_at?: string | Date | null;
  allowEarlyJoinMinutes?: number | null;
  allow_early_join_minutes?: number | null;
}

export interface RoomJoinAvailabilityInput extends RoomScheduleMetadata {
  schedule?: RoomScheduleMetadata | null;
}

export interface RoomJoinAvailability {
  kind: "open" | "scheduled" | "not_yet_open";
  isJoinAllowed: boolean;
  startsAtMs: number | null;
  opensAtMs: number | null;
  remainingMs: number | null;
}

export interface CreateAuthenticatedRoomInput {
  apiUrl: string;
  accessToken: string;
  name?: string;
  config?: CreateRoomConfig;
}

const MINUTE_MS = 60_000;

const toEpochMs = (value: string | Date | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const toNonNegativeNumber = (value: number | null | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
};

const readScheduleStart = (room: RoomJoinAvailabilityInput | null | undefined): number | null => {
  if (!room) {
    return null;
  }

  return toEpochMs(room.scheduledStartAt ?? room.scheduled_start_at ?? room.schedule?.scheduledStartAt ?? room.schedule?.scheduled_start_at);
};

const readAllowEarlyJoinMinutes = (room: RoomJoinAvailabilityInput | null | undefined): number => {
  if (!room) {
    return 0;
  }

  return toNonNegativeNumber(room.allowEarlyJoinMinutes ?? room.allow_early_join_minutes ?? room.schedule?.allowEarlyJoinMinutes ?? room.schedule?.allow_early_join_minutes);
};

export const getRoomJoinAvailability = (room: RoomJoinAvailabilityInput | null | undefined, now: number | Date = Date.now()): RoomJoinAvailability => {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const startsAtMs = readScheduleStart(room);

  if (!startsAtMs) {
    return {
      kind: "open",
      isJoinAllowed: true,
      startsAtMs: null,
      opensAtMs: null,
      remainingMs: null,
    };
  }

  const opensAtMs = startsAtMs - readAllowEarlyJoinMinutes(room) * MINUTE_MS;
  if (nowMs < opensAtMs) {
    return {
      kind: "not_yet_open",
      isJoinAllowed: false,
      startsAtMs,
      opensAtMs,
      remainingMs: opensAtMs - nowMs,
    };
  }

  return {
    kind: "scheduled",
    isJoinAllowed: true,
    startsAtMs,
    opensAtMs,
    remainingMs: null,
  };
};

export const createAuthenticatedRoom = async ({ apiUrl, accessToken, name, config }: CreateAuthenticatedRoomInput): Promise<RoomResource> => {
  const normalizedApiUrl = apiUrl.trim();
  const normalizedAccessToken = accessToken.trim();

  if (!normalizedApiUrl) {
    throw new Error("apiUrl is required");
  }
  if (!normalizedAccessToken) {
    throw new Error("accessToken is required");
  }

  const apiClient = new APIClient({
    apiUrl: normalizedApiUrl,
    token: normalizedAccessToken,
  });

  return createRoom(apiClient, {
    name,
    config,
  });
};

