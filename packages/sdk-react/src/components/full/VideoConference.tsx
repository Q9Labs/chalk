/**
 * VideoConference - Turnkey video conferencing component
 *
 * Level 0: Zero-config, just provide roomId and userName.
 * Handles the full flow: lobby -> joining -> meeting -> end.
 */

import type React from "react";
import { memo } from "react";

import { LeaveConfirmationDialog } from "../composite/LeaveConfirmationDialog";
import { EndScreen } from "./EndScreen";
import { MeetingRoom } from "./MeetingRoom";
import { PreJoinLobby } from "./PreJoinLobby";
import type { VideoConferenceProps } from "./video-conference/types";
import { useVideoConferenceController } from "./video-conference/useVideoConferenceController";

function VideoConferenceBase(props: VideoConferenceProps): React.JSX.Element {
  const { phase, preJoinProps, meetingRoomProps, endScreenProps, leaveDialogProps } = useVideoConferenceController(props);

  if (phase === "lobby" || phase === "joining") {
    return <PreJoinLobby {...preJoinProps} />;
  }

  if (phase === "end") {
    return <EndScreen {...endScreenProps} />;
  }

  return (
    <>
      <MeetingRoom {...meetingRoomProps} />

      <LeaveConfirmationDialog isOpen={leaveDialogProps.isOpen} onClose={leaveDialogProps.onClose} onConfirm={leaveDialogProps.onConfirm} />
    </>
  );
}

VideoConferenceBase.displayName = "VideoConference";

export type { MeetingEndData, MeetingJoinedData, ParticipantSession, VideoConferenceProps } from "./video-conference/types";

export const VideoConference = memo(VideoConferenceBase);
export default VideoConference;
