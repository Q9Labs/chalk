import type { ScreenShareOptions, ScreenShareState } from "../internal/core";
import { useCallback, useMemo } from "react";
import { useSession } from "../context/chalk-native-provider";
import { useManagerState } from "./external-store";

export interface UseScreenShareReturn {
  isActive: boolean;
  isStarting: boolean;
  isLocalSharing: boolean;
  sharerParticipantId: string | null;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  start: (options?: ScreenShareOptions) => Promise<boolean>;
  stop: () => Promise<void>;
  toggle: (options?: ScreenShareOptions) => Promise<boolean>;
}

export function useScreenShare(): UseScreenShareReturn {
  const session = useSession();
  const { screenShare } = session;
  const state = useManagerState<ScreenShareState>(screenShare);

  const start = useCallback((options?: ScreenShareOptions) => screenShare.start(options), [screenShare]);
  const stop = useCallback(() => screenShare.stop(), [screenShare]);
  const toggle = useCallback(
    async (options?: ScreenShareOptions) => {
      if (state.isLocalSharing) {
        await screenShare.stop();
        return false;
      }

      return screenShare.start(options);
    },
    [screenShare, state.isLocalSharing],
  );

  return useMemo(
    () => ({
      isActive: state.isActive,
      isStarting: state.isStarting,
      isLocalSharing: state.isLocalSharing,
      sharerParticipantId: state.sharerParticipantId,
      videoTrack: state.videoTrack,
      audioTrack: state.audioTrack,
      start,
      stop,
      toggle,
    }),
    [state, start, stop, toggle],
  );
}
