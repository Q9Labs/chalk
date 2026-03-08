import { cn } from "../../../utils/cn";
import { AudioRenderer } from "../../atomic";
import { ConnectionLostOverlay, InviteModal, InviteToast } from "../../composite";
import { GuidedTour } from "../GuidedTour";
import type { Participant } from "./types";

interface MeetingRoomOverlaysProps {
  connectionState: "connected" | "connecting" | "reconnecting" | "failed";
  onRetryConnection?: () => void;
  connectionSupportCode?: string;
  enableTour: boolean;
  showTour: boolean;
  onTourComplete: () => void;
  showInviteModal: boolean;
  setShowInviteModal: (show: boolean) => void;
  showInviteToast: boolean;
  setShowInviteToast: (show: boolean) => void;
  isMobile: boolean;
  roomName: string;
  onCopyLink: () => void;
  allParticipants: Participant[];
  getParticipantVolume?: (participantId: string) => number;
  selectedAudioOutput?: string;
  volume?: number;
}

export function MeetingRoomOverlays({
  connectionState,
  onRetryConnection,
  connectionSupportCode,
  enableTour,
  showTour,
  onTourComplete,
  showInviteModal,
  setShowInviteModal,
  showInviteToast,
  setShowInviteToast,
  isMobile,
  roomName,
  onCopyLink,
  allParticipants,
  getParticipantVolume,
  selectedAudioOutput,
  volume = 1,
}: MeetingRoomOverlaysProps) {
  const meetingLink = typeof window !== "undefined" ? window.location.href : "";

  return (
    <>
      <ConnectionLostOverlay isVisible={connectionState === "reconnecting" || connectionState === "failed"} status={connectionState === "reconnecting" ? "reconnecting" : "failed"} onRetry={onRetryConnection} supportCode={connectionSupportCode} />

      {enableTour && <GuidedTour isOpen={showTour} onComplete={onTourComplete} onSkip={onTourComplete} showSkip={true} />}

      <InviteModal isOpen={showInviteModal} onClose={() => setShowInviteModal(false)} meetingLink={meetingLink} meetingId={roomName} onCopyLink={onCopyLink} />

      <InviteToast isVisible={showInviteToast && !showTour} onDismiss={() => setShowInviteToast(false)} meetingLink={meetingLink} className={cn(isMobile && "top-4 bottom-auto left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm")} />

      <AudioRenderer participants={allParticipants} getParticipantVolume={getParticipantVolume} audioOutputDeviceId={selectedAudioOutput} volume={volume} />
    </>
  );
}
