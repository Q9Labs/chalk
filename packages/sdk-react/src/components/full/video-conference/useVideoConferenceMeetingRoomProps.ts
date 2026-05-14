import { useMeetingRoomProps, type UseMeetingRoomPropsParams } from "./useMeetingRoomProps";
import { useMeetingRoomViewModel, type UseMeetingRoomViewModelParams } from "./useMeetingRoomViewModel";
import { useParticipantModeration, type UseParticipantModerationParams } from "./useParticipantModeration";

interface UseVideoConferenceMeetingRoomPropsParams {
  viewModelParams: UseMeetingRoomViewModelParams;
  moderationSession: UseParticipantModerationParams["session"];
  meetingRoomParams: Omit<UseMeetingRoomPropsParams, "localParticipant" | "participants" | "canManageParticipants" | "handleToggleParticipantMute" | "handleRemoveParticipant" | "chatMessages" | "meetingLayout" | "selectedAudioOutput">;
}

export function useVideoConferenceMeetingRoomProps({ viewModelParams, moderationSession, meetingRoomParams }: UseVideoConferenceMeetingRoomPropsParams) {
  const { allParticipants, localMeetingParticipant, chatMessages, meetingLayout, selectedAudioOutput, canManageParticipants } = useMeetingRoomViewModel(viewModelParams);

  const { handleToggleParticipantMute, handleRemoveParticipant } = useParticipantModeration({
    canManageParticipants,
    participants: viewModelParams.participants,
    session: moderationSession,
  });

  const meetingRoomProps = useMeetingRoomProps({
    ...meetingRoomParams,
    localParticipant: localMeetingParticipant,
    participants: allParticipants,
    canManageParticipants,
    handleToggleParticipantMute,
    handleRemoveParticipant,
    chatMessages,
    meetingLayout,
    selectedAudioOutput,
  });

  return {
    meetingRoomProps,
  };
}
