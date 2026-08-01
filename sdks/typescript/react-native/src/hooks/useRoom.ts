import { useMemo } from "react";

import { useChalkSnapshot } from "./useChalkSnapshot";

export interface UseRoomReturn {
  readonly roomId: string | null;
  readonly roomName: string | null;
  readonly status: "connecting" | "connected" | "disconnected" | "failed" | "reconnecting";
  readonly isConnected: boolean;
  readonly isJoining: boolean;
  readonly hostId: string | null;
}

export function useRoom(): UseRoomReturn {
  const snapshot = useChalkSnapshot();
  return useMemo(() => {
    const host = snapshot.participants.find((participant) => participant.role === "host");
    return {
      roomId: snapshot.subject?.roomId ?? null,
      roomName: null,
      status: sessionStatus(snapshot.state),
      isConnected: snapshot.state === "live",
      isJoining: snapshot.state === "joining",
      hostId: host?.participantSessionId ?? null,
    };
  }, [snapshot]);
}

function sessionStatus(state: ReturnType<typeof useChalkSnapshot>["state"]): UseRoomReturn["status"] {
  if (state === "joining") return "connecting";
  if (state === "live") return "connected";
  if (state === "reconnecting") return "reconnecting";
  if (state === "failed") return "failed";
  return "disconnected";
}
