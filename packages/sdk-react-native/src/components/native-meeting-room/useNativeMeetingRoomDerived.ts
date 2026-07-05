import type { ParticipantState } from "../../internal/core";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import type { UseScreenShareReturn } from "../../hooks/useScreenShare";
import { NATIVE_COMPACT_VIEWPORT_MAX_WIDTH, resolveNativeMeetingLayout } from "../../utils/native-meeting-layout";

type RoomParticipant = ParticipantState["participants"][number];

interface UseNativeMeetingRoomDerivedOptions {
  participants: readonly RoomParticipant[];
  localParticipant: RoomParticipant | null;
  screenShare: Pick<UseScreenShareReturn, "isActive" | "isLocalSharing" | "sharerParticipantId" | "videoTrack">;
  isWhiteboardOpen: boolean;
}

export function useNativeMeetingRoomDerived({ participants, localParticipant, screenShare, isWhiteboardOpen }: UseNativeMeetingRoomDerivedOptions) {
  const { width } = useWindowDimensions();

  return useMemo(
    () =>
      resolveNativeMeetingLayout({
        participants,
        localParticipant,
        screenShare,
        isWhiteboardOpen,
        isCompactViewport: width < NATIVE_COMPACT_VIEWPORT_MAX_WIDTH,
      }),
    [participants, localParticipant, screenShare, isWhiteboardOpen, width],
  );
}
