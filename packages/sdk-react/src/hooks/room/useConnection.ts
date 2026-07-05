export function useConnection() {
  return { status: "disconnected", isConnected: false, isJoining: false, join: async () => {}, joinWithJoinToken: async () => {}, joinWithInviteLink: async () => {}, leave: async () => {}, createSession: async () => "", endSession: async () => {} };
}
