import type { ScreenShareOptions, ScreenShareState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

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
  const [state, setState] = useState<ScreenShareState>(() => screenShare.getState());

  useEffect(() => screenShare.subscribe(setState), [screenShare]);

  const start = useCallback((options?: ScreenShareOptions) => screenShare.start(options), [screenShare]);
  const stop = useCallback(() => screenShare.stop(), [screenShare]);
  const toggle = useCallback(
    async (options?: ScreenShareOptions) => {
      if (screenShare.isLocalSharing) {
        await screenShare.stop();
        return false;
      }

      return screenShare.start(options);
    },
    [screenShare],
  );

  return useMemo(
    () => ({
      isActive: state.isActive,
      isStarting: state.isStarting,
      isLocalSharing: screenShare.isLocalSharing,
      sharerParticipantId: state.sharerParticipantId,
      videoTrack: state.videoTrack,
      audioTrack: state.audioTrack,
      start,
      stop,
      toggle,
    }),
    [state, screenShare, start, stop, toggle],
  );
}
