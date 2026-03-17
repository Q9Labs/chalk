export function canStartNativeJoin(phase: "lobby" | "joining" | "meeting" | "end", isJoining: boolean, isConnected: boolean, hasPendingJoinRequest: boolean): boolean {
  return phase === "lobby" && !isJoining && !isConnected && !hasPendingJoinRequest;
}

export function canExecuteNativeJoin(phase: "lobby" | "joining" | "meeting" | "end", joinNonce: number, isJoining: boolean, isConnected: boolean, hasPendingJoinRequest: boolean, activeJoinNonce: number | null): boolean {
  return phase === "joining" && joinNonce > 0 && !isJoining && !isConnected && hasPendingJoinRequest && activeJoinNonce !== joinNonce;
}
