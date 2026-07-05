export function useWhiteboardPermissions() {
  return { canGrant: false, grantAll: () => {}, revokeAll: () => {}, grant: (_participantId: string) => {}, revoke: (_participantId: string) => {} };
}
