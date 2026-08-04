import { mediaDevices, type NativeMediaStream } from "../media/native-webrtc";
import { useMemo, useSyncExternalStore } from "react";
import type { PreJoinPreviewMode } from "../components/PreJoinScreen";
import { getIosSimulatorVideoMessage, isIosSimulator } from "../utils/ios-simulator";
import { createPreJoinPreviewStore } from "./pre-join-preview-store";

export interface UsePreJoinPreviewReturn {
  previewStream: NativeMediaStream | null;
  previewError: string | null;
}

export function usePreJoinPreview(enabled: boolean, previewMode: PreJoinPreviewMode = "device"): UsePreJoinPreviewReturn {
  const simulatorVideoDisabled = isIosSimulator();
  const store = useMemo(
    () =>
      createPreJoinPreviewStore({
        enabled,
        previewMode,
        simulatorVideoDisabled,
        simulatorVideoMessage: getIosSimulatorVideoMessage(),
        getUserMedia: mediaDevices.getUserMedia,
      }),
    [enabled, previewMode, simulatorVideoDisabled],
  );
  const { previewStream, previewError } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return { previewStream, previewError };
}
