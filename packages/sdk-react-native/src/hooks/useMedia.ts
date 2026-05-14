import type { MediaDevice, MediaState, VideoBackgroundEffect } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UseMediaReturn {
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  isTogglingVideo: boolean;
  isTogglingAudio: boolean;
  devices: readonly MediaDevice[];
  cameras: readonly MediaDevice[];
  microphones: readonly MediaDevice[];
  speakers: readonly MediaDevice[];
  selectedCamera: string | null;
  selectedMicrophone: string | null;
  selectedSpeaker: string | null;
  isBackgroundEffectsSupported: boolean;
  isApplyingBackgroundEffect: boolean;
  selectedBackgroundEffect: VideoBackgroundEffect;
  toggleVideo: () => Promise<boolean>;
  toggleAudio: () => Promise<boolean>;
  applyBackgroundEffect: (effect: VideoBackgroundEffect) => Promise<void>;
  clearBackgroundEffect: () => Promise<void>;
  selectCamera: (deviceId: string) => Promise<void>;
  selectMicrophone: (deviceId: string) => Promise<void>;
  selectSpeaker: (deviceId: string) => Promise<void>;
  refreshDevices: () => Promise<readonly MediaDevice[]>;
  undoDeviceChange: () => void;
}

export function useMedia(): UseMediaReturn {
  const session = useSession();
  const { media } = session;
  const [state, setState] = useState<MediaState>(() => media.getState());

  useEffect(() => media.subscribe(setState), [media]);

  const toggleVideo = useCallback(() => media.toggleVideo(), [media]);
  const toggleAudio = useCallback(() => media.toggleAudio(), [media]);
  const applyBackgroundEffect = useCallback((effect: VideoBackgroundEffect) => media.applyBackgroundEffect(effect), [media]);
  const clearBackgroundEffect = useCallback(() => media.clearBackgroundEffect(), [media]);
  const selectCamera = useCallback((deviceId: string) => media.selectCamera(deviceId), [media]);
  const selectMicrophone = useCallback((deviceId: string) => media.selectMicrophone(deviceId), [media]);
  const selectSpeaker = useCallback((deviceId: string) => media.selectSpeaker(deviceId), [media]);
  const refreshDevices = useCallback(() => media.refreshDevices(), [media]);
  const undoDeviceChange = useCallback(() => media.undoDeviceChange(), [media]);

  return useMemo(
    () => ({
      isVideoEnabled: state.isVideoEnabled,
      isAudioEnabled: state.isAudioEnabled,
      isTogglingVideo: state.isTogglingVideo,
      isTogglingAudio: state.isTogglingAudio,
      devices: state.devices,
      cameras: media.cameras,
      microphones: media.microphones,
      speakers: media.speakers,
      selectedCamera: state.selectedCamera,
      selectedMicrophone: state.selectedMicrophone,
      selectedSpeaker: state.selectedSpeaker,
      isBackgroundEffectsSupported: state.isBackgroundEffectsSupported,
      isApplyingBackgroundEffect: state.isApplyingBackgroundEffect,
      selectedBackgroundEffect: state.selectedBackgroundEffect,
      toggleVideo,
      toggleAudio,
      applyBackgroundEffect,
      clearBackgroundEffect,
      selectCamera,
      selectMicrophone,
      selectSpeaker,
      refreshDevices,
      undoDeviceChange,
    }),
    [state, media, toggleVideo, toggleAudio, applyBackgroundEffect, clearBackgroundEffect, selectCamera, selectMicrophone, selectSpeaker, refreshDevices, undoDeviceChange],
  );
}
