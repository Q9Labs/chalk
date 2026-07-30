import { useCallback, useMemo } from "react";

import { useChalkSession } from "../context/chalk-native-provider";
import { useChalkSnapshot } from "./useChalkRoomActions";

export interface UseMediaReturn {
  readonly isVideoEnabled: boolean;
  readonly isAudioEnabled: boolean;
  readonly isTogglingVideo: boolean;
  readonly isTogglingAudio: boolean;
  readonly toggleVideo: () => Promise<boolean>;
  readonly toggleAudio: () => Promise<boolean>;
}

export function useMedia(): UseMediaReturn {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const camera = snapshot.localMedia.camera;
  const microphone = snapshot.localMedia.microphone;
  const isVideoEnabled = camera.state === "enabled" || camera.state === "requesting";
  const isAudioEnabled = microphone.state === "enabled" || microphone.state === "requesting";
  const toggleVideo = useCallback(async () => {
    const enabled = !isVideoEnabled;
    await session.setCameraEnabled(enabled);
    return enabled;
  }, [isVideoEnabled, session]);
  const toggleAudio = useCallback(async () => {
    const enabled = !isAudioEnabled;
    await session.setMicrophoneEnabled(enabled);
    return enabled;
  }, [isAudioEnabled, session]);

  return useMemo(
    () => ({
      isVideoEnabled,
      isAudioEnabled,
      isTogglingVideo: camera.state === "requesting",
      isTogglingAudio: microphone.state === "requesting",
      toggleVideo,
      toggleAudio,
    }),
    [camera.state, isAudioEnabled, isVideoEnabled, microphone.state, toggleAudio, toggleVideo],
  );
}
