/**
 * useScreenShare - Screen sharing from ScreenShareManager
 */

import type { ScreenShareOptions, ScreenShareState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseScreenShareReturn {
  /** Whether screen share is active */
  isActive: boolean;
  /** Whether screen share is starting */
  isStarting: boolean;
  /** Whether local user is the sharer */
  isLocalSharing: boolean;
  /** Participant ID who is sharing */
  sharerParticipantId: string | null;
  /** Screen share video track */
  videoTrack: MediaStreamTrack | null;
  /** Screen share audio track */
  audioTrack: MediaStreamTrack | null;
  /** Start screen sharing */
  start: (options?: ScreenShareOptions) => Promise<boolean>;
  /** Stop screen sharing */
  stop: () => Promise<void>;
  /** Toggle screen sharing */
  toggle: (options?: ScreenShareOptions) => Promise<boolean>;
}

/**
 * Hook for screen sharing
 *
 * @example
 * ```tsx
 * function ScreenShareButton() {
 *   const { isActive, isLocalSharing, toggle, isStarting } = useScreenShare();
 *
 *   return (
 *     <button onClick={() => toggle()} disabled={isStarting}>
 *       {isLocalSharing ? 'Stop Sharing' : 'Share Screen'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useScreenShare(): UseScreenShareReturn {
  const session = useSession();
  const { screenShare } = session;

  const [state, setState] = useState<ScreenShareState>(() => screenShare.getState());

  useEffect(() => {
    return screenShare.subscribe(setState);
  }, [screenShare]);

  const start = useCallback((options?: ScreenShareOptions): Promise<boolean> => screenShare.start(options), [screenShare]);

  const stop = useCallback((): Promise<void> => screenShare.stop(), [screenShare]);

  const toggle = useCallback(
    async (options?: ScreenShareOptions): Promise<boolean> => {
      if (screenShare.isLocalSharing) {
        await screenShare.stop();
        return false;
      }
      return screenShare.start(options);
    },
    [screenShare],
  );

  return useMemo(
    (): UseScreenShareReturn => ({
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
