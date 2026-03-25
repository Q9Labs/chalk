export function canStartNativeJoin(phase: "lobby" | "joining" | "meeting" | "end", isJoining: boolean, isConnected: boolean, hasPendingJoinRequest: boolean): boolean {
  return phase === "lobby" && !isJoining && !isConnected && !hasPendingJoinRequest;
}

export function canExecuteNativeJoin(phase: "lobby" | "joining" | "meeting" | "end", joinNonce: number, isJoining: boolean, isConnected: boolean, hasPendingJoinRequest: boolean, activeJoinNonce: number | null): boolean {
  return phase === "joining" && joinNonce > 0 && !isJoining && !isConnected && hasPendingJoinRequest && activeJoinNonce !== joinNonce;
}

interface ShouldPromoteAfterJoinErrorArgs {
  error: unknown;
  expectedRoomId: string;
  activeRoomId: string | null;
  roomStateRoomId: string | null;
  roomStatus: "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";
}

const getJoinErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "";
};

export function shouldPromoteAfterJoinError({ error, expectedRoomId, activeRoomId, roomStateRoomId, roomStatus }: ShouldPromoteAfterJoinErrorArgs): boolean {
  const message = getJoinErrorMessage(error);
  if (!message.includes("Already connected to a room")) {
    return false;
  }

  if (roomStatus !== "connected") {
    return false;
  }

  return activeRoomId === expectedRoomId || roomStateRoomId === expectedRoomId;
}
