import { useCallback, useMemo } from "react";

import { useChalkSession } from "../context/chalk-provider";
import { useChalkSnapshot } from "./useChalkSnapshot";

export interface UseScreenShareReturn {
  readonly isActive: boolean;
  readonly isStarting: boolean;
  readonly isLocalSharing: boolean;
  readonly sharerParticipantId: string | null;
  readonly videoTrack: MediaStreamTrack | null;
  readonly audioTrack: MediaStreamTrack | null;
  readonly start: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
  readonly toggle: () => Promise<boolean>;
}

export function useScreenShare(): UseScreenShareReturn {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const local = snapshot.localMedia.screen;
  const remote = snapshot.remoteMedia.find((publication) => publication.source === "screen") ?? null;
  const isLocalSharing = local.state === "enabled" || local.state === "requesting";
  const start = useCallback(async () => {
    await session.startScreenShare();
    return true;
  }, [session]);
  const stop = useCallback(() => session.stopScreenShare(), [session]);
  const toggle = useCallback(async () => {
    if (isLocalSharing) {
      await stop();
      return false;
    }
    return start();
  }, [isLocalSharing, start, stop]);

  return useMemo(
    () => ({
      isActive: isLocalSharing || remote !== null,
      isStarting: local.state === "requesting",
      isLocalSharing,
      sharerParticipantId: isLocalSharing ? (snapshot.subject?.participantId ?? null) : (remote?.participantId ?? null),
      videoTrack: isLocalSharing ? local.track : (remote?.track ?? null),
      audioTrack: null,
      start,
      stop,
      toggle,
    }),
    [isLocalSharing, local.state, local.track, remote, snapshot.subject?.participantId, start, stop, toggle],
  );
}
