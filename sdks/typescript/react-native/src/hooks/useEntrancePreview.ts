import { mediaDevices, type NativeMediaStream } from "../media/native-webrtc";
import { useMemo, useSyncExternalStore } from "react";
import { getIosSimulatorVideoMessage, isIosSimulator } from "../utils/ios-simulator";
import { createEntrancePreviewStore } from "./entrance-preview-store";

export interface UseEntrancePreviewReturn {
  previewStream: NativeMediaStream | null;
  previewError: string | null;
}

export function useEntrancePreview(enabled: boolean): UseEntrancePreviewReturn {
  const simulatorVideoDisabled = isIosSimulator();
  const store = useMemo(
    () =>
      createEntrancePreviewStore({
        enabled,
        simulatorVideoDisabled,
        simulatorVideoMessage: getIosSimulatorVideoMessage(),
        getUserMedia: mediaDevices.getUserMedia,
      }),
    [enabled, simulatorVideoDisabled],
  );
  const { previewStream, previewError } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return { previewStream, previewError };
}
