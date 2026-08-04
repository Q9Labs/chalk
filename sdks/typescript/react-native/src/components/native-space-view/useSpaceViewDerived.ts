import type { NativeParticipantState } from "../../ui/native-types";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { NATIVE_COMPACT_VIEWPORT_MAX_WIDTH, resolveNativeSpaceLayout, type NativeScreenShareStateLike } from "../../utils/native-space-layout";

type SpaceParticipant = NativeParticipantState["participants"][number];

interface UseSpaceViewDerivedOptions {
  participants: readonly SpaceParticipant[];
  localParticipant: SpaceParticipant | null;
  screenShare: NativeScreenShareStateLike;
  isWhiteboardOpen: boolean;
}

export function useSpaceViewDerived({ participants, localParticipant, screenShare, isWhiteboardOpen }: UseSpaceViewDerivedOptions) {
  const { width } = useWindowDimensions();

  return useMemo(
    () =>
      resolveNativeSpaceLayout({
        participants,
        localParticipant,
        screenShare,
        isWhiteboardOpen,
        isCompactViewport: width < NATIVE_COMPACT_VIEWPORT_MAX_WIDTH,
      }),
    [participants, localParticipant, screenShare, isWhiteboardOpen, width],
  );
}
