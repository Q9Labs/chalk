export function useVideoConferenceController(props: any) {
  return {
    phase: "lobby",
    preJoinProps: props,
    meetingRoomProps: props,
    endScreenProps: props,
    leaveDialogProps: { isOpen: false, onClose: () => {}, onConfirm: async () => {} },
  };
}
