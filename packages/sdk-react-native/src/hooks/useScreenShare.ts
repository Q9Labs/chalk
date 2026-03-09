/**
 * useScreenShare hook - Screen sharing for React Native
 */

import { useCallback, useState } from "react";
import { useChalk } from "../ChalkProvider";

export interface UseScreenShareResult {
  isScreenSharing: boolean;
  startScreenShare: () => Promise<boolean>;
  stopScreenShare: () => Promise<void>;
  error: Error | null;
}

export function useScreenShare(): UseScreenShareResult {
  const { rtcManager, rtkClient } = useChalk();
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const startScreenShare = useCallback(async (): Promise<boolean> => {
    // Prefer RTK if available
    if (rtkClient?.self) {
      try {
        await rtkClient.self.enableScreenShare();
        setIsScreenSharing(true);
        setError(null);
        return true;
      } catch (err) {
        const screenShareError = err instanceof Error ? err : new Error("Screen share failed");
        setError(screenShareError);
        return false;
      }
    }

    // Fallback to RTCManager
    if (!rtcManager) {
      setError(new Error("RTCManager not initialized"));
      return false;
    }

    try {
      const success = await rtcManager.startScreenShare();
      setIsScreenSharing(success);
      setError(null);
      return success;
    } catch (err) {
      const screenShareError = err instanceof Error ? err : new Error("Screen share failed");
      setError(screenShareError);
      return false;
    }
  }, [rtcManager, rtkClient]);

  const stopScreenShare = useCallback(async (): Promise<void> => {
    // Prefer RTK if available
    if (rtkClient?.self) {
      try {
        await rtkClient.self.disableScreenShare();
        setIsScreenSharing(false);
        setError(null);
        return;
      } catch (err) {
        const stopError = err instanceof Error ? err : new Error("Failed to stop screen share");
        setError(stopError);
        return;
      }
    }

    // Fallback to RTCManager
    if (!rtcManager) return;

    try {
      await rtcManager.stopScreenShare();
      setIsScreenSharing(false);
      setError(null);
    } catch (err) {
      const stopError = err instanceof Error ? err : new Error("Failed to stop screen share");
      setError(stopError);
    }
  }, [rtcManager, rtkClient]);

  return {
    isScreenSharing,
    startScreenShare,
    stopScreenShare,
    error,
  };
}
