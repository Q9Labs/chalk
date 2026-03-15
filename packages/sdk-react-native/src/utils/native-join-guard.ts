export function canStartNativeJoin(phase: "lobby" | "joining" | "meeting" | "end", isJoining: boolean, isConnected: boolean, hasPendingJoinRequest: boolean): boolean {
  return phase === "lobby" && !isJoining && !isConnected && !hasPendingJoinRequest;
}
