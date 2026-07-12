import { useMemo, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { addAndroidConnectionServiceListener, endAndroidConnectionServiceCall, ensureAndroidConnectionServiceRegistered, setAndroidConnectionServiceActive, startAndroidConnectionServiceCall } from "../android/connection-service";
import { AndroidConnectionServiceController } from "./android-connection-service-controller";
import type { NativeVideoConferencePhase } from "./NativeVideoConference";

interface UseAndroidConnectionServiceOptions {
  displayName: string;
  enabled: boolean;
  hasVideo: boolean;
  joinNonce: number;
  onDisconnectRequest: () => void;
  phase: NativeVideoConferencePhase;
  roomId: string;
  roomName: string;
}

export function useAndroidConnectionService({ displayName, enabled, hasVideo, joinNonce, onDisconnectRequest, phase, roomId, roomName }: UseAndroidConnectionServiceOptions): void {
  const isEnabled = enabled && Platform.OS === "android";
  const controller = useMemo(
    () =>
      new AndroidConnectionServiceController(
        {
          displayName,
          enabled: isEnabled,
          hasVideo,
          joinNonce,
          onDisconnectRequest,
          phase,
          roomId,
          roomName,
        },
        {
          addListener: addAndroidConnectionServiceListener,
          endCall: endAndroidConnectionServiceCall,
          ensureRegistered: ensureAndroidConnectionServiceRegistered,
          setActive: setAndroidConnectionServiceActive,
          startCall: startAndroidConnectionServiceCall,
        },
      ),
    [],
  );

  controller.update({
    displayName,
    enabled: isEnabled,
    hasVideo,
    joinNonce,
    onDisconnectRequest,
    phase,
    roomId,
    roomName,
  });
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
