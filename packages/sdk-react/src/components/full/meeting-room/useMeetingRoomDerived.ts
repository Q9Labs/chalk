export function useMeetingRoomDerived({ participants = [], localParticipant = null, enableWhiteboard = false, isWhiteboardOpen = false, isMobile = false }: { participants?: any[]; localParticipant?: any; enableWhiteboard?: boolean; isWhiteboardOpen?: boolean; isMobile?: boolean } = {}) {
  const screenSharer = participants.find((participant) => participant?.isScreenSharing) ?? null;
  return { allParticipants: localParticipant ? [localParticipant, ...participants.filter((p) => p?.id !== localParticipant?.id)] : participants, screenSharer, isSplit: false, isStageMode: Boolean(enableWhiteboard && isWhiteboardOpen && !isMobile) };
}
