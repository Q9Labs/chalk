import { mediaDevices, type NativeMediaStream } from "../media/realtimekit/native-webrtc";
import { useMemo, useSyncExternalStore } from "react";
import { getIosSimulatorVideoMessage, isIosSimulator } from "../utils/ios-simulator";
import { createPreJoinPreviewStore } from "./pre-join-preview-store";

export interface UsePreJoinPreviewReturn {
  previewStream: NativeMediaStream | null;
  previewError: string | null;
}

export function usePreJoinPreview(enabled: boolean): UsePreJoinPreviewReturn {
  const simulatorVideoDisabled = isIosSimulator();
  const store = useMemo(
    () =>
      createPreJoinPreviewStore({
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
