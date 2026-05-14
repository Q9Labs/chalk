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
import { LoadingScreen } from "./LoadingScreen";
import { MeetingRoom } from "./MeetingRoom";
import { PreJoinLobby } from "./PreJoinLobby";
import { SharedPictureInPictureProvider } from "./picture-in-picture/PictureInPictureContext";
import type { VideoConferenceProps } from "./video-conference/types";
import { useVideoConferenceController } from "./video-conference/useVideoConferenceController";
import { useMobileAppRedirect } from "../../hooks/useMobileAppRedirect";

function MobileAppRedirectScreen({
  error,
  userName,
}: {
  error: string | null;
  userName: string;
}): React.JSX.Element {
  if (!error) {
    return (
      <LoadingScreen
        message="Opening Chalk..."
        displayName={userName}
        supportingMessages={[
          "We’re handing this meeting off to the mobile app.",
        ]}
      />
    );
  }

  return (
    <div data-chalk className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card/90 p-6 shadow-2xl backdrop-blur-sm space-y-4 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-primary/80">
          Open In Chalk
        </p>
        <h1 className="text-2xl font-semibold leading-tight">
          Chalk needs to open in the mobile app.
        </h1>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    </div>
  );
}

function VideoConferenceContent(props: VideoConferenceProps): React.JSX.Element {
  const { phase, preJoinProps, meetingRoomProps, endScreenProps, leaveDialogProps } = useVideoConferenceController(props);
  const enableSharedPictureInPicture = phase === "lobby" || phase === "joining" ? Boolean(preJoinProps.enablePictureInPicture) : phase === "meeting" ? Boolean(meetingRoomProps.enablePictureInPicture) : false;

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

function VideoConferenceBase(props: VideoConferenceProps): React.JSX.Element {
  const mobileRedirect = useMobileAppRedirect({
    roomId: props.roomId,
    joinToken: props.joinToken,
    inviteLink: props.inviteLink,
    iosStoreUrl: props.mobileRedirect?.iosStoreUrl,
    publicAppUrl: props.mobileRedirect?.publicAppUrl,
    onError: props.onError,
  });

  if (mobileRedirect.isBlocking) {
    return (
      <MobileAppRedirectScreen
        error={mobileRedirect.status === "failed" ? mobileRedirect.error : null}
        userName={props.userName}
      />
    );
  }

  return <VideoConferenceContent {...props} />;
}

VideoConferenceBase.displayName = "VideoConference";

export type { MeetingEndData, MeetingJoinedData, ParticipantSession, VideoConferenceProps } from "./video-conference/types";

export const VideoConference = memo(VideoConferenceBase);
export default VideoConference;
