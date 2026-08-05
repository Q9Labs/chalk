import { useMemo, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { addAndroidConnectionServiceListener, endAndroidConnectionServiceCall, ensureAndroidConnectionServiceRegistered, setAndroidConnectionServiceActive, startAndroidConnectionServiceCall } from "../android/connection-service";
import { AndroidConnectionServiceController } from "./android-connection-service-controller";
import type { SpaceLifecyclePhase } from "./space-lifecycle";

interface UseAndroidConnectionServiceOptions {
  displayName: string;
  enabled: boolean;
  hasVideo: boolean;
  joinNonce: number;
  onDisconnectRequest: () => void;
  phase: SpaceLifecyclePhase;
  spaceId: string;
  spaceName: string;
}

export function useAndroidConnectionService({ displayName, enabled, hasVideo, joinNonce, onDisconnectRequest, phase, spaceId, spaceName }: UseAndroidConnectionServiceOptions): void {
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
          spaceId,
          spaceName,
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
    spaceId,
    spaceName,
  });
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
