import type { RoomState } from "../internal/core";
import { useMemo } from "react";
import { useSession } from "../context/chalk-native-provider";
import { useManagerState } from "./external-store";

export interface UseRoomReturn {
  roomId: string | null;
  roomName: string | null;
  status: RoomState["status"];
  isConnected: boolean;
  isJoining: boolean;
  hostId: string | null;
}

export function useRoom(): UseRoomReturn {
  const session = useSession();
  const { room } = session;
  const state = useManagerState<RoomState>(room);

  return useMemo(
    () => ({
      roomId: state.roomId,
      roomName: state.roomName,
      status: state.status,
      isConnected: state.status === "connected",
      isJoining: state.isJoining,
      hostId: state.hostId,
    }),
    [state],
  );
}
