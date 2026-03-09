/**
 * useConnection - Connection actions and status
 */

import type { JoinOptions, LeaveOptions, RoomState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseConnectionReturn {
  /** Connection status */
  status: string;
  /** Whether connected to a room */
  isConnected: boolean;
  /** Whether join is in progress */
  isJoining: boolean;
  /** Join a room */
  join: (roomId: string, options: JoinOptions) => Promise<void>;
  /** Leave the current room */
  leave: (options?: LeaveOptions) => Promise<void>;
  /** Create a new room */
  createSession: (name?: string) => Promise<string>;
  /** End room for all participants (host only) */
  endSession: (roomId: string) => Promise<void>;
}

/**
 * Hook for connection management
 *
 * @example
 * ```tsx
 * function JoinButton() {
 *   const { join, isJoining, isConnected } = useConnection();
 *
 *   const handleJoin = async () => {
 *     await join('room_123', { userName: 'John' });
 *   };
 *
 *   if (isConnected) return <div>Connected!</div>;
 *
 *   return (
 *     <button onClick={handleJoin} disabled={isJoining}>
 *       {isJoining ? 'Joining...' : 'Join Room'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useConnection(): UseConnectionReturn {
  const session = useSession();
  const { room } = session;

  const [state, setState] = useState<RoomState>(() => room.getState());

  useEffect(() => {
    return room.subscribe(setState);
  }, [room]);

  const join = useCallback(
    async (roomId: string, options: JoinOptions): Promise<void> => {
      await session.join(roomId, options);
    },
    [session],
  );

  const leave = useCallback(
    async (options?: LeaveOptions): Promise<void> => {
      await session.leave(options);
    },
    [session],
  );

  const createSession = useCallback(
    async (name?: string): Promise<string> => {
      return session.createSession(name);
    },
    [session],
  );

  const endSession = useCallback(
    async (roomId: string): Promise<void> => {
      return session.endSession(roomId);
    },
    [session],
  );

  return useMemo(
    (): UseConnectionReturn => ({
      status: state.status,
      isConnected: state.status === "connected",
      isJoining: state.isJoining,
      join,
      leave,
      createSession,
      endSession,
    }),
    [state.status, state.isJoining, join, leave, createSession, endSession],
  );
}
