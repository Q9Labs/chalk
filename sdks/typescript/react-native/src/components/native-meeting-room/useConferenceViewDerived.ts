import type { NativeParticipantState } from "../../ui/native-types";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import type { UseScreenShareReturn } from "../../hooks/useScreenShare";
import { NATIVE_COMPACT_VIEWPORT_MAX_WIDTH, resolveNativeMeetingLayout } from "../../utils/native-meeting-layout";

type RoomParticipant = NativeParticipantState["participants"][number];

interface UseConferenceViewDerivedOptions {
  participants: readonly RoomParticipant[];
  localParticipant: RoomParticipant | null;
  screenShare: Pick<UseScreenShareReturn, "isActive" | "isLocalSharing" | "sharerParticipantId" | "videoTrack">;
  isWhiteboardOpen: boolean;
}

export function useConferenceViewDerived({ participants, localParticipant, screenShare, isWhiteboardOpen }: UseConferenceViewDerivedOptions) {
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
