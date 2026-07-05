import type { MediaDevice, MediaState } from "../internal/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UseDevicesReturn {
  devices: readonly MediaDevice[];
  cameras: readonly MediaDevice[];
  microphones: readonly MediaDevice[];
  speakers: readonly MediaDevice[];
  selectedCamera: string | null;
  selectedMicrophone: string | null;
  selectedSpeaker: string | null;
  isLoading: boolean;
  selectCamera: (deviceId: string) => Promise<void>;
  selectMicrophone: (deviceId: string) => Promise<void>;
  selectSpeaker: (deviceId: string) => Promise<void>;
  refreshDevices: () => Promise<readonly MediaDevice[]>;
  undoDeviceChange: () => void;
}

export function useDevices(): UseDevicesReturn {
  const session = useSession();
  const { media } = session;
  const [state, setState] = useState<MediaState>(() => media.getState());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => media.subscribe(setState), [media]);

  const selectCamera = useCallback((deviceId: string) => media.selectCamera(deviceId), [media]);
  const selectMicrophone = useCallback((deviceId: string) => media.selectMicrophone(deviceId), [media]);
  const selectSpeaker = useCallback((deviceId: string) => media.selectSpeaker(deviceId), [media]);
  const refreshDevices = useCallback(async () => {
    setIsLoading(true);
    try {
      return await media.refreshDevices();
    } finally {
      setIsLoading(false);
    }
  }, [media]);
  const undoDeviceChange = useCallback(() => media.undoDeviceChange(), [media]);

  return useMemo(
    () => ({
      devices: state.devices,
      cameras: media.cameras,
      microphones: media.microphones,
      speakers: media.speakers,
      selectedCamera: state.selectedCamera,
      selectedMicrophone: state.selectedMicrophone,
      selectedSpeaker: state.selectedSpeaker,
      isLoading,
      selectCamera,
      selectMicrophone,
      selectSpeaker,
      refreshDevices,
      undoDeviceChange,
    }),
    [state, media, isLoading, selectCamera, selectMicrophone, selectSpeaker, refreshDevices, undoDeviceChange],
  );
}
