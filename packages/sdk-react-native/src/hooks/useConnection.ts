import type { JoinOptions, LeaveOptions, RoomState } from "../internal/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UseConnectionReturn {
  status: RoomState["status"];
  isConnected: boolean;
  isJoining: boolean;
  join: (roomId: string, options: JoinOptions) => Promise<void>;
  leave: (options?: LeaveOptions) => Promise<void>;
  createSession: (name?: string) => Promise<string>;
  endSession: (roomId: string) => Promise<void>;
}

export function useConnection(): UseConnectionReturn {
  const session = useSession();
  const { room } = session;
  const [state, setState] = useState<RoomState>(() => room.getState());

  useEffect(() => room.subscribe(setState), [room]);

  const join = useCallback(async (roomId: string, options: JoinOptions) => session.join(roomId, options), [session]);

  const leave = useCallback(async (options?: LeaveOptions) => session.leave(options), [session]);

  const createSession = useCallback(async (name?: string) => session.createSession(name), [session]);

  const endSession = useCallback(async (roomId: string) => session.endSession(roomId), [session]);

  return useMemo(
    () => ({
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
