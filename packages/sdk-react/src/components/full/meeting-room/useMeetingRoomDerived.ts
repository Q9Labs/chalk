import { useMemo } from "react";

import type { Participant } from "./types";

interface UseMeetingRoomDerivedOptions {
  participants: Participant[];
  localParticipant: Participant;
  isMobile: boolean;
  enableWhiteboard: boolean;
  isWhiteboardOpen: boolean;
}

export function useMeetingRoomDerived({ participants, localParticipant, isMobile, enableWhiteboard, isWhiteboardOpen }: UseMeetingRoomDerivedOptions) {
  const screenSharer = useMemo(() => participants.find((participant) => participant.isScreenSharing), [participants]);
  const showScreenShare = Boolean(screenSharer);
  const isSplit = !isMobile && enableWhiteboard && isWhiteboardOpen && showScreenShare;
  const isStageMode = isSplit || (enableWhiteboard && isWhiteboardOpen) || (showScreenShare && Boolean(screenSharer?.screenShareTrack));

  const allParticipants = useMemo(() => {
    const others = participants.filter((p) => p.id !== localParticipant?.id);
    return localParticipant ? [localParticipant, ...others] : participants;
  }, [localParticipant, participants]);

  return {
    allParticipants,
    screenSharer,
    isSplit,
    isStageMode,
  };
}
