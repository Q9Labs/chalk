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
import { SharedPictureInPictureProvider } from "./picture-in-picture/PictureInPictureContext";
import type { VideoConferenceProps } from "./video-conference/types";
import { useVideoConferenceController } from "./video-conference/useVideoConferenceController";

function VideoConferenceBase(props: VideoConferenceProps): React.JSX.Element {
  const { phase, preJoinProps, meetingRoomProps, endScreenProps, leaveDialogProps } = useVideoConferenceController(props);
  const enableSharedPictureInPicture =
    phase === "lobby" || phase === "joining"
      ? Boolean(preJoinProps.enablePictureInPicture)
      : phase === "meeting"
        ? Boolean(meetingRoomProps.enablePictureInPicture)
        : false;

  return (
    <SharedPictureInPictureProvider enabled={enableSharedPictureInPicture}>
      {phase === "lobby" || phase === "joining" ? (
        <PreJoinLobby {...preJoinProps} />
      ) : phase === "end" ? (
        <EndScreen {...endScreenProps} />
      ) : (
        <>
          <MeetingRoom {...meetingRoomProps} />

          <LeaveConfirmationDialog isOpen={leaveDialogProps.isOpen} onClose={leaveDialogProps.onClose} onConfirm={leaveDialogProps.onConfirm} />
        </>
      )}
    </SharedPictureInPictureProvider>
  );
}

VideoConferenceBase.displayName = "VideoConference";

export type { MeetingEndData, MeetingJoinedData, ParticipantSession, VideoConferenceProps } from "./video-conference/types";

export const VideoConference = memo(VideoConferenceBase);
export default VideoConference;
