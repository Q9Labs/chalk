export function canStartNativeJoin(phase: "lobby" | "joining" | "meeting" | "end", isJoining: boolean, isConnected: boolean, hasPendingJoinRequest: boolean): boolean {
  return phase === "lobby" && !isJoining && !isConnected && !hasPendingJoinRequest;
}

export function canExecuteNativeJoin(phase: "lobby" | "joining" | "meeting" | "end", joinNonce: number, isJoining: boolean, isConnected: boolean, hasPendingJoinRequest: boolean, activeJoinNonce: number | null): boolean {
  return phase === "joining" && joinNonce > 0 && !isJoining && !isConnected && hasPendingJoinRequest && activeJoinNonce !== joinNonce;
}

interface ShouldFailNativeJoinAfterDisconnectArgs {
  phase: "lobby" | "joining" | "meeting" | "end";
  hasPendingJoinRequest: boolean;
  activeJoinNonce: number | null;
  isJoining: boolean;
  isConnected: boolean;
  expectedRoomId: string;
  activeRoomId: string | null;
  roomStatus: "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";
  websocketConnectionState: string;
  joinAttemptAgeMs: number | null;
}

const JOIN_DISCONNECT_GRACE_MS = 3_000;
const JOIN_DISCONNECT_HARD_TIMEOUT_MS = 15_000;

export function shouldFailNativeJoinAfterDisconnect({ phase, hasPendingJoinRequest, activeJoinNonce, isJoining, isConnected, expectedRoomId, activeRoomId, roomStatus, websocketConnectionState, joinAttemptAgeMs }: ShouldFailNativeJoinAfterDisconnectArgs): boolean {
  if (phase !== "joining" || !hasPendingJoinRequest || activeJoinNonce === null || isJoining || isConnected) {
    return false;
  }

  if (activeRoomId !== expectedRoomId) {
    return false;
  }

  if (roomStatus !== "disconnected" && roomStatus !== "failed") {
    return false;
  }

  if (joinAttemptAgeMs === null) {
    return false;
  }

  if (joinAttemptAgeMs >= JOIN_DISCONNECT_HARD_TIMEOUT_MS) {
    return true;
  }

  if (websocketConnectionState === "connecting") {
    return false;
  }

  return joinAttemptAgeMs >= JOIN_DISCONNECT_GRACE_MS;
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
