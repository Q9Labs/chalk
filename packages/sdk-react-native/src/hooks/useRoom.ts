import type { RoomState } from "../internal/core";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

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
  const [state, setState] = useState<RoomState>(() => room.getState());

  useEffect(() => room.subscribe(setState), [room]);

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
