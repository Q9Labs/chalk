/**
 * useRoom - Access room state from RoomManager
 */

import type { RoomState } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseRoomReturn {
  /** Current room ID (null if not connected) */
  roomId: string | null;
  /** Room name */
  roomName: string | null;
  /** Connection status */
  status: string;
  /** Whether currently connected */
  isConnected: boolean;
  /** Whether join is in progress */
  isJoining: boolean;
  /** Host participant ID */
  hostId: string | null;
}

/**
 * Hook to access room state
 *
 * @example
 * ```tsx
 * function SessionConnectionState() {
 *   const { isConnected, status, roomId } = useRoom();
 *
 *   if (!isConnected) {
 *     return <div>Status: {status}</div>;
 *   }
 *
 *   return <div>Connected to {roomId}</div>;
 * }
 * ```
 */
export function useRoom(): UseRoomReturn {
  const session = useSession();
  const { room } = session;

  const [state, setState] = useState<RoomState>(() => room.getState());

  useEffect(() => {
    return room.subscribe(setState);
  }, [room]);

  return useMemo(
    (): UseRoomReturn => ({
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
