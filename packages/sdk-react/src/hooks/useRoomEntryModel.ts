export function useRoomEntryModel() {
  return { availability: { canJoin: true, reason: null }, error: null, isLoading: false, meetingLink: "", role: "participant", room: null, shouldForceInternalAuth: false };
}
