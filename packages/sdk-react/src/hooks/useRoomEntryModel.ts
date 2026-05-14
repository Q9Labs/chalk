import { APIClient, getRoomJoinAvailability, isCanonicalRoomId, type RoomJoinAvailability, type RoomResource } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { buildPublicJoinLink } from "../utils/mobileRedirect";

export interface RoomEntryJoinContext {
  joinToken?: string;
}

export interface UseRoomEntryModelOptions {
  apiUrl: string;
  authMode?: "internal";
  joinContext?: RoomEntryJoinContext | null;
  nowMs?: number;
  publicAppUrl?: string;
  roomId: string;
  roomName?: string;
  tokenProvider: () => Promise<string>;
}

export interface UseRoomEntryModelResult {
  availability: RoomJoinAvailability;
  error: Error | null;
  isLoading: boolean;
  meetingLink: string;
  role: "host" | "participant";
  room: RoomResource | null;
  shouldForceInternalAuth: boolean;
}

const OPEN_ROOM_AVAILABILITY = getRoomJoinAvailability(null);

export function useRoomEntryModel({
  apiUrl,
  authMode,
  joinContext,
  nowMs = Date.now(),
  publicAppUrl,
  roomId,
  tokenProvider,
}: UseRoomEntryModelOptions): UseRoomEntryModelResult {
  const [room, setRoom] = useState<RoomResource | null>(null);
  const [meetingLink, setMeetingLink] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(() => isCanonicalRoomId(roomId));

  const role = joinContext?.joinToken ? "participant" : "host";
  const shouldLookupRoom = isCanonicalRoomId(roomId);

  useEffect(() => {
    if (!shouldLookupRoom) {
      setRoom(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const token = await tokenProvider();
        const client = new APIClient({
          apiUrl,
          token,
        });
        const response = await client.getRoom(roomId);
        if (!response.success || !response.data) {
          throw new Error(response.error?.message ?? "Room not found");
        }
        if (!cancelled) {
          setRoom(response.data);
          setIsLoading(false);
        }
      } catch (roomError) {
        if (!cancelled) {
          setRoom(null);
          setError(roomError instanceof Error ? roomError : new Error(String(roomError)));
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiUrl, roomId, shouldLookupRoom, tokenProvider]);

  useEffect(() => {
    if (joinContext?.joinToken) {
      setMeetingLink(buildPublicJoinLink(joinContext.joinToken, publicAppUrl, typeof window !== "undefined" ? window.location.origin : undefined));
      return;
    }

    if (!shouldLookupRoom) {
      setMeetingLink("");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const token = await tokenProvider();
        const client = new APIClient({
          apiUrl,
          token,
        });
        const response = await client.createJoinToken(roomId);
        if (!response.success || !response.data?.joinToken) {
          throw new Error(response.error?.message ?? "Failed to create join link");
        }

        if (!cancelled) {
          setMeetingLink(buildPublicJoinLink(response.data.joinToken, publicAppUrl, typeof window !== "undefined" ? window.location.origin : undefined));
        }
      } catch {
        if (!cancelled) {
          setMeetingLink("");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiUrl, joinContext?.joinToken, publicAppUrl, roomId, shouldLookupRoom, tokenProvider]);

  const shouldForceInternalAuth = useMemo(() => {
    const usingInternalAuth = authMode === "internal" || !joinContext?.joinToken;
    return Boolean(room) && shouldLookupRoom && usingInternalAuth && authMode !== "internal";
  }, [authMode, joinContext?.joinToken, room, shouldLookupRoom]);

  const availability = useMemo(() => getRoomJoinAvailability(room, nowMs), [nowMs, room]);

  return {
    availability: room ? availability : OPEN_ROOM_AVAILABILITY,
    error,
    isLoading,
    meetingLink,
    role,
    room,
    shouldForceInternalAuth,
  };
}
